export interface PathTreeFile {
  kind: "file";
  name: string;
  path: string;
}
export interface PathTreeDirectory<File extends PathTreeFile = PathTreeFile> {
  kind: "directory";
  name: string;
  path: string;
  children: PathTreeNode<File>[];
}
export type PathTreeNode<File extends PathTreeFile = PathTreeFile> = File | PathTreeDirectory<File>;

/** Shared in-memory tree for review files and immutable Skill resources. */
export function buildPathTree<File extends PathTreeFile>(
  files: readonly File[],
  compare = (left: string, right: string) => left.localeCompare(right),
): PathTreeNode<File>[] {
  type Directory = {
    name: string;
    path: string;
    directories: Map<string, Directory>;
    files: File[];
  };
  const create = (name: string, path: string): Directory => ({
    name,
    path,
    directories: new Map(),
    files: [],
  });
  const root = create("", "");
  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    if (!parts.length) continue;
    let directory = root;
    for (const part of parts.slice(0, -1)) {
      const path = directory.path ? `${directory.path}/${part}` : part;
      let child = directory.directories.get(part);
      if (!child) {
        child = create(part, path);
        directory.directories.set(part, child);
      }
      directory = child;
    }
    directory.files.push(file);
  }
  const finalize = (directory: Directory): PathTreeNode<File>[] => {
    const folders = [...directory.directories.values()]
      .map((child): PathTreeDirectory<File> => {
        let node: PathTreeDirectory<File> = {
          kind: "directory",
          name: child.name,
          path: child.path,
          children: finalize(child),
        };
        while (node.children.length === 1 && node.children[0]?.kind === "directory") {
          const nested = node.children[0];
          node = { ...nested, name: `${node.name}/${nested.name}` };
        }
        return node;
      })
      .sort((left, right) => compare(left.name, right.name));
    return [
      ...folders,
      ...directory.files.toSorted((left, right) => compare(left.name, right.name)),
    ];
  };
  return finalize(root);
}
