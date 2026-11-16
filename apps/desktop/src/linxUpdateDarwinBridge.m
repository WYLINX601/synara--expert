#import <Foundation/Foundation.h>
#import <CoreServices/CoreServices.h>
#include <copyfile.h>
#include <libproc.h>
#include <dirent.h>
#include <sys/stat.h>
#include <sys/file.h>
#include <sys/xattr.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int fail(const char *message) { fprintf(stderr, "%s: %s\n", message, strerror(errno)); return 1; }
static BOOL regular(const char *path) { struct stat s; return lstat(path, &s) == 0 && S_ISREG(s.st_mode); }
static int copyAttribute(const char *source, const char *target, const char *name) {
    ssize_t size = getxattr(source, name, NULL, 0, 0, XATTR_NOFOLLOW);
    if (size < 0) return errno == ENOATTR ? 0 : fail("read provenance");
    if (size > 1024 * 1024) { errno = EFBIG; return fail("provenance too large"); }
    void *bytes = malloc(size ? (size_t)size : 1);
    if (!bytes) return fail("allocate provenance");
    ssize_t readSize = getxattr(source, name, bytes, (size_t)size, 0, XATTR_NOFOLLOW);
    int result = readSize != size || setxattr(target, name, bytes, (size_t)size, 0, XATTR_NOFOLLOW) != 0;
    free(bytes);
    return result ? fail("copy provenance") : 0;
}
static BOOL privateRecord(const struct stat *record) {
    return S_ISREG(record->st_mode) && record->st_uid == getuid() &&
        record->st_nlink == 1 && (record->st_mode & 07777) == 0600;
}
static BOOL targetLockIdentity(const char *path, int directory, const struct stat *dir,
                               int guard, const struct stat *lease) {
    struct stat named, opened;
    return lstat(path, &named) == 0 && S_ISDIR(named.st_mode) &&
        named.st_dev == dir->st_dev && named.st_ino == dir->st_ino &&
        named.st_uid == getuid() && (named.st_mode & 07777) == 0700 &&
        fstat(guard, &opened) == 0 && privateRecord(&opened) && opened.st_size == 0 &&
        fstatat(directory, "guard", &named, AT_SYMLINK_NOFOLLOW) == 0 &&
        privateRecord(&named) && named.st_size == 0 &&
        named.st_dev == lease->st_dev && named.st_ino == lease->st_ino;
}
static BOOL targetLockEntries(int directory) {
    int scan = openat(directory, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (scan < 0) return NO;
    DIR *entries = fdopendir(scan);
    if (!entries) { close(scan); return NO; }
    BOOL valid = YES;
    struct dirent *entry;
    errno = 0;
    while ((entry = readdir(entries))) {
        const char *name = entry->d_name;
        if (strcmp(name, ".") == 0 || strcmp(name, "..") == 0) continue;
        struct stat record;
        if ((strcmp(name, "guard") != 0 && strcmp(name, "owner") != 0 &&
             strcmp(name, "owner.pending") != 0) ||
            fstatat(directory, name, &record, AT_SYMLINK_NOFOLLOW) != 0 ||
            !privateRecord(&record) || record.st_size >= PATH_MAX ||
            (strcmp(name, "guard") == 0 && record.st_size != 0)) {
            valid = NO; break;
        }
        errno = 0;
    }
    if (errno != 0) valid = NO;
    closedir(entries);
    return valid;
}
static BOOL targetOwnerIdentity(int directory, int owner, const char *attempt, size_t length) {
    struct stat opened, named;
    char bytes[PATH_MAX];
    return fstat(owner, &opened) == 0 && privateRecord(&opened) &&
        fstatat(directory, "owner", &named, AT_SYMLINK_NOFOLLOW) == 0 &&
        privateRecord(&named) && named.st_dev == opened.st_dev && named.st_ino == opened.st_ino &&
        pread(owner, bytes, sizeof(bytes), 0) == (ssize_t)length &&
        memcmp(bytes, attempt, length) == 0;
}
static int targetLock(const char *path, const char *attempt) {
    size_t length = strlen(attempt);
    if (!length || length >= PATH_MAX || strchr(attempt, '\n') ||
        path[0] != '/' || strlen(path) >= PATH_MAX) return 2;
    char parentPath[PATH_MAX], canonical[PATH_MAX];
    strlcpy(parentPath, path, sizeof(parentPath));
    char *separator = strrchr(parentPath, '/');
    if (!separator || separator == parentPath || !separator[1]) return 2;
    *separator = '\0';
    if (!realpath(parentPath, canonical) || strcmp(parentPath, canonical) != 0) {
        errno = EACCES; return fail("noncanonical installation lock parent");
    }
    int parent = open(parentPath, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    struct stat parentRecord;
    if (parent < 0 || fstat(parent, &parentRecord) != 0 ||
        (parentRecord.st_uid != 0 && parentRecord.st_uid != getuid()) ||
        (parentRecord.st_mode & S_IWOTH)) {
        errno = EACCES; return fail("unproven installation lock parent");
    }
    if (mkdir(path, 0700) != 0 && errno != EEXIST) return fail("create installation lock");
    int directory = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    struct stat dir, lease, record;
    if (directory < 0 || fstat(directory, &dir) != 0 || !S_ISDIR(dir.st_mode) ||
        dir.st_uid != getuid() || (dir.st_mode & 07777) != 0700 ||
        !realpath(path, canonical) || strcmp(path, canonical) != 0) {
        errno = EACCES; return fail("unproven installation lock owner");
    }
    int guard = openat(directory, "guard", O_RDWR | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
    if (guard < 0 && errno == ENOENT) {
        if (fstatat(directory, "owner", &record, AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT ||
            fstatat(directory, "owner.pending", &record, AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT) {
            errno = EBUSY; return fail("installation owner has no stable guard");
        }
        guard = openat(directory, "guard", O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
        if (guard < 0 && errno == EEXIST)
            guard = openat(directory, "guard", O_RDWR | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
    }
    if (guard < 0 || fstat(guard, &lease) != 0 || !privateRecord(&lease) || lease.st_size != 0 ||
        flock(guard, LOCK_EX | LOCK_NB) != 0 ||
        !targetLockIdentity(path, directory, &dir, guard, &lease) || !targetLockEntries(directory)) {
        errno = EBUSY; return fail("installation target is locked or unknown");
    }
    if (fsync(guard) != 0 || fsync(directory) != 0 || fsync(parent) != 0)
        return fail("persist installation guard");
    int owner = openat(directory, "owner", O_RDWR | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
    if (owner >= 0) {
        if (!targetOwnerIdentity(directory, owner, attempt, length)) {
            errno = EBUSY; return fail("installation belongs to another interrupted attempt");
        }
    } else if (errno != ENOENT) {
        return fail("inspect installation owner");
    }
    if (unlinkat(directory, "owner.pending", 0) != 0 && errno != ENOENT)
        return fail("retire uncommitted installation owner");
    if (owner < 0) {
        owner = openat(directory, "owner.pending", O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
        if (owner < 0 || fstat(owner, &record) != 0 || !privateRecord(&record) ||
            write(owner, attempt, length) != (ssize_t)length || fsync(owner) != 0 ||
            !targetLockIdentity(path, directory, &dir, guard, &lease) ||
            renameatx_np(directory, "owner.pending", directory, "owner", RENAME_EXCL) != 0)
            return fail("publish installation owner");
    }
    if (fsync(owner) != 0 || fsync(directory) != 0)
        return fail("persist installation owner");
    char command[32];
    BOOL complete = NO;
    for (;;) {
        if (!targetLockIdentity(path, directory, &dir, guard, &lease) ||
            !targetLockEntries(directory) || !targetOwnerIdentity(directory, owner, attempt, length)) {
            errno = EBUSY; return fail("installation lock identity changed");
        }
        if (complete) {
            if (unlinkat(directory, "owner", 0) != 0 || fsync(directory) != 0)
                return fail("release installation lock");
            break;
        }
        puts("locked"); fflush(stdout);
        if (!fgets(command, sizeof(command), stdin)) break;
        if (strcmp(command, "check\n") == 0) continue;
        if (strcmp(command, "release\n") == 0) { complete = YES; continue; }
        return 2;
    }
    close(owner); close(guard); close(directory); close(parent);
    return 0;
}
int main(int argc, const char *argv[]) { @autoreleasepool {
    if (argc == 4 && strcmp(argv[1], "target-lock") == 0)
        return targetLock(argv[2], argv[3]);
    if (argc == 3 && strcmp(argv[1], "pidpath") == 0) {
        char *end = NULL; long pid = strtol(argv[2], &end, 10);
        if (!end || *end || pid <= 0 || pid > INT_MAX) return 2;
        char buffer[PROC_PIDPATHINFO_MAXSIZE];
        if (proc_pidpath((int)pid, buffer, sizeof(buffer)) <= 0) return fail("proc_pidpath");
        puts(buffer); return 0;
    }
    if (argc == 4 && strcmp(argv[1], "preflight") == 0) {
        struct stat app, parent;
        if (lstat(argv[2], &app) != 0 || lstat(argv[3], &parent) != 0) return fail("inspect installation permissions");
        const unsigned long blocked = UF_IMMUTABLE | SF_IMMUTABLE | UF_APPEND | SF_APPEND;
        if (!S_ISDIR(app.st_mode) || !S_ISDIR(parent.st_mode) || app.st_dev != parent.st_dev ||
            (app.st_flags & blocked) || (parent.st_flags & blocked) ||
            (parent.st_mode & S_IWOTH) || (parent.st_uid != 0 && parent.st_uid != getuid()) ||
            access(argv[3], W_OK | X_OK) != 0) {
            errno = EACCES; return fail("installation requires writable same-filesystem application parent");
        }
        return 0;
    }
    if (argc == 4 && strcmp(argv[1], "unpack") == 0) {
        struct stat target;
        if (!regular(argv[2]) || lstat(argv[3], &target) != 0 ||
            (!S_ISREG(target.st_mode) && !S_ISDIR(target.st_mode) && !S_ISLNK(target.st_mode))) { errno = EINVAL; return fail("unsafe AppleDouble target"); }
        // COPYFILE_NOFOLLOW opens a destination link itself (O_SYMLINK), retaining
        // legitimate framework-link metadata without writing through that link.
        return copyfile(argv[2], argv[3], NULL, COPYFILE_UNPACK | COPYFILE_XATTR | COPYFILE_NOFOLLOW) == 0 ? 0 : fail("unpack AppleDouble");
    }
    if (argc == 4 && strcmp(argv[1], "provenance") == 0) {
        struct stat target;
        if (!regular(argv[2]) || lstat(argv[3], &target) != 0 || !S_ISDIR(target.st_mode)) { errno = EINVAL; return fail("unsafe provenance paths"); }
        if (copyAttribute(argv[2], argv[3], "com.apple.quarantine")) return 1;
        return copyAttribute(argv[2], argv[3], "com.apple.metadata:kMDItemWhereFroms");
    }
    if (argc == 4 && strcmp(argv[1], "mark-download") == 0) {
        if (!regular(argv[2])) { errno = EINVAL; return fail("unsafe download path"); }
        NSURL *file = [NSURL fileURLWithFileSystemRepresentation:argv[2] isDirectory:NO relativeToURL:nil];
        NSURL *origin = [NSURL URLWithString:[NSString stringWithUTF8String:argv[3]]];
        if (![origin.scheme isEqualToString:@"https"] || ![origin.host isEqualToString:@"github.com"] ||
            origin.user || origin.password || origin.fragment || origin.query || origin.port) return 2;
        NSArray<NSString *> *parts = origin.path.pathComponents;
        if (parts.count != 7 || ![parts[3] isEqualToString:@"releases"] || ![parts[4] isEqualToString:@"download"]) return 2;
        NSURLComponents *page = [NSURLComponents componentsWithURL:origin resolvingAgainstBaseURL:NO];
        page.path = [NSString stringWithFormat:@"/%@/%@/releases/tag/%@", parts[1], parts[2], parts[5]];
        NSError *error = nil; id existing = nil;
        if (![file getResourceValue:&existing forKey:NSURLQuarantinePropertiesKey error:&error]) { fprintf(stderr, "%s\n", error.description.UTF8String); return 1; }
        // Existing OS/download-agent decisions are never weakened or replaced.
        if (existing != nil) return 0;
        NSDictionary *properties = @{ (NSString *)kLSQuarantineTypeKey: (NSString *)kLSQuarantineTypeWebDownload,
            (NSString *)kLSQuarantineDataURLKey: origin, (NSString *)kLSQuarantineOriginURLKey: page.URL,
            (NSString *)kLSQuarantineAgentBundleIdentifierKey: @"com.wylinx.linx" };
        if (![file setResourceValue:properties forKey:NSURLQuarantinePropertiesKey error:&error]) { fprintf(stderr, "%s\n", error.description.UTF8String); return 1; }
        const char *whereFrom = "com.apple.metadata:kMDItemWhereFroms";
        if (getxattr(argv[2], whereFrom, NULL, 0, 0, XATTR_NOFOLLOW) < 0) {
            if (errno != ENOATTR) return fail("read download origin");
            NSData *data = [NSPropertyListSerialization dataWithPropertyList:@[origin.absoluteString, page.URL.absoluteString]
                format:NSPropertyListBinaryFormat_v1_0 options:0 error:&error];
            if (!data) { fprintf(stderr, "%s\n", error.description.UTF8String); return 1; }
            if (setxattr(argv[2], whereFrom, data.bytes, data.length, 0, XATTR_NOFOLLOW | XATTR_CREATE) != 0 && errno != EEXIST)
                return fail("record download origin");
        }
        return 0;
    }
    return 2;
} }
