import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const unitName = "domain2lmdb";

function unitPath(path: string): string {
  return JSON.stringify(path.replaceAll("%", "%%"));
}

function systemctl(...args: string[]): void {
  const { exitCode } = Bun.spawnSync(
    ["systemctl", "--user", ...args],
    { stdout: "inherit", stderr: "inherit" },
  );
  if (exitCode !== 0) throw new Error("systemctl --user " + args.join(" ") + " gagal.");
}

async function start(): Promise<void> {
  const directory = join(Bun.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd", "user");
  const service = [
    "[Unit]",
    "Description=Fetch Komdigi RPZ and build blocklist.lmdb",
    "",
    "[Service]",
    "Type=oneshot",
    "ExecStart=:" + unitPath(process.execPath) + " --cwd " + unitPath(import.meta.dir) + " run convert.ts",
    "",
  ].join("\n");
  const timer = [
    "[Unit]",
    "Description=Run domain2lmdb every day at midnight WIB",
    "",
    "[Timer]",
    "OnCalendar=*-*-* 00:00:00 Asia/Jakarta",
    "AccuracySec=1s",
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");

  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, unitName + ".service"), service);
  await writeFile(join(directory, unitName + ".timer"), timer);
  systemctl("daemon-reload");
  systemctl("enable", "--now", unitName + ".timer");
  console.log("Jadwal aktif setiap pukul 00.00 WIB.");
}

try {
  await start();
} catch (error) {
  console.error("Gagal mengaktifkan jadwal —", error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
