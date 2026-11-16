import { LINX_HOME_OWNERSHIP_NONCE_ENV } from "@synara/contracts";
import { joinLinxHomeOwnershipForServer } from "../linxUpdateHomeOwnership";

const nonce = process.env[LINX_HOME_OWNERSHIP_NONCE_ENV];
delete process.env[LINX_HOME_OWNERSHIP_NONCE_ENV];
try {
  const release = await joinLinxHomeOwnershipForServer({
    homePath: process.argv[2]!,
    ...(nonce === undefined ? {} : { nonce }),
    parentPid: process.ppid,
  });
  process.stdout.write("joined\n");
  process.stdin.resume();
  process.stdin.once("end", () => {
    void (release?.() ?? Promise.resolve()).then(
      () => process.stdout.write("released\n"),
      (error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      },
    );
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
