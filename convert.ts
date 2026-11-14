import { mkdtemp, rename, rm } from "node:fs/promises";
import { isIP } from "node:net";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import * as lmdb from "lmdb";

const outputPath = resolve("blocklist.lmdb");
const blockedValue = Buffer.from([0x31]);
const domainLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const resourceRecord = /^(\S+)[ \t]+\d+[ \t]+IN[ \t]+(\S+)[ \t]+(.+)$/i;
const transferTimeout = 240_000;

function hostnameRejection(name: string): string | undefined {
  if (name.length > 253) return "nama melebihi batas 253 karakter";

  for (const label of name.split(".")) {
    if (domainLabel.test(label)) continue;
    if (label.length === 0) return "label kosong";
    if (label.length > 63) return "label melebihi batas 63 karakter";
    if (label.includes("*")) return "wildcard tersisa setelah normalisasi";
    if (label.includes("_")) return "label mengandung underscore";
    if (label.includes("\\")) return "label mengandung escape DNS";
    if (/[^\x00-\x7f]/.test(label)) return "label mengandung karakter non-ASCII";
    if (/[^a-z0-9-]/i.test(label)) return "label mengandung karakter ASCII yang tidak diizinkan";
    return "label diawali atau diakhiri tanda hubung";
  }
}

function toWireKey(name: string): Buffer {
  const key = Buffer.alloc(name.length + 2);
  let offset = 0;
  for (const label of name.split(".")) {
    key[offset++] = label.length;
    offset += key.write(label, offset, "ascii");
  }
  return key;
}

type RpzServer = { host: string; port: string };

function rpzServer(name: "RPZ_PRIMARY" | "RPZ_SECONDARY"): RpzServer {
  const server = Bun.env[name]?.trim() ?? "";
  if (!isIP(server) && hostnameRejection(server.replace(/\.$/, ""))) {
    throw new Error(name + " harus berisi alamat IP atau nama host yang valid di .env.");
  }
  const portName = name === "RPZ_PRIMARY" ? "RPZ_PRIMARY_PORT" : "RPZ_SECONDARY_PORT";
  const port = Bun.env[portName]?.trim() ?? "53";
  if (!/^[0-9]{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error(portName + " harus berisi port 1–65535 di .env.");
  }
  return { host: server, port };
}

async function transferZone(dig: string, server: RpzServer, zone: string): Promise<Set<string>> {
  const child = Bun.spawn(
    [dig, "-r", "@" + server.host, "-p", server.port, zone, "AXFR", "+tcp", "+norecurse", "+time=60", "+tries=1",
      "+noall", "+answer", "+comments", "+stats", "+noonesoa", "+nomultiline", "+norrcomments"],
    {
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, IDN_DISABLE: "1" },
      timeout: transferTimeout,
    },
  );
  const stdout = Readable.fromWeb(child.stdout);
  const lines = createInterface({ input: stdout, crlfDelay: Infinity });
  const domains = new Set<string>();
  const zoneSuffix = "." + zone;
  let sawStatus = false;
  let openingSoa = "";
  let closedSoa = false;
  let recordCount = 0;
  let skippedNames = 0;
  const skippedByReason = new Map<string, number>();
  let reportedCount: number | undefined;
  let readError: Error | undefined;
  lines.on("error", (error: Error) => {
    readError = error;
    lines.close();
  });

  try {
    for await (const line of lines) {
      if (line.startsWith(";")) {
        const status = /^;; ->>HEADER<<- .*status:\s*([A-Z0-9?]+),/i.exec(line)?.[1];
        if (status) {
          if (status.toUpperCase() !== "NOERROR") throw new Error("Status DNS " + status + ".");
          sawStatus = true;
        }
        const size = /^;; XFR size:\s*(\d+) records\b/.exec(line)?.[1];
        if (size) reportedCount = Number(size);
        if (/^;+\s*Transfer failed\b/i.test(line)) throw new Error("dig melaporkan transfer gagal.");
        continue;
      }

      const record = resourceRecord.exec(line.trim());
      if (!record) continue;
      const [, owner = "", rawType = "", data = ""] = record;
      const type = rawType.toUpperCase();
      const ownerLower = owner.toLowerCase();
      recordCount++;

      if (closedSoa || (recordCount === 1 && type !== "SOA")) {
        throw new Error("Urutan record AXFR tidak valid.");
      }

      if (type === "SOA") {
        const soa = data.toLowerCase().split(/\s+/);
        if (ownerLower !== zone || soa.length !== 7 || !soa.slice(2).every((field) => /^\d+$/.test(field))) {
          throw new Error("SOA zona RPZ tidak valid.");
        }
        const signature = soa.join(" ");
        if (recordCount === 1) {
          openingSoa = signature;
        } else {
          if (signature !== openingSoa) throw new Error("SOA penutup berbeda dari SOA pembuka.");
          closedSoa = true;
        }
        continue;
      }

      if (type !== "CNAME" || !ownerLower.endsWith(zoneSuffix)) continue;
      const relative = owner.slice(0, -zoneSuffix.length).replace(/^\*\./, "");
      const reason = hostnameRejection(relative);
      if (reason) {
        skippedNames++;
        skippedByReason.set(reason, (skippedByReason.get(reason) ?? 0) + 1);
        continue;
      }
      domains.add(relative.toLowerCase());
    }

    if (readError) throw readError;
    const exitCode = await child.exited;
    if (exitCode !== 0 || child.signalCode !== null) {
      throw new Error(child.signalCode ? "dig dihentikan (" + child.signalCode + ")." : "dig keluar dengan kode " + exitCode + ".");
    }
    if (!sawStatus || !closedSoa || reportedCount !== recordCount) {
      throw new Error("Transfer AXFR tidak lengkap atau jumlah record berbeda dari laporan dig.");
    }
    if (domains.size === 0) throw new Error("Transfer tidak menghasilkan domain valid dari CNAME dalam zona RPZ.");
    if (skippedNames > 0) {
      console.warn(skippedNames + " record CNAME dilewati karena nama domain tidak valid.");
      for (const [reason, count] of [...skippedByReason].sort((a, b) => b[1] - a[1])) {
        console.warn("  " + count + " record — " + reason);
      }
    }
    return domains;
  } finally {
    lines.close();
    stdout.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await child.exited;
  }
}

async function fetchDomains(): Promise<Set<string>> {
  const zoneName = (Bun.env.RPZ_ZONE?.trim() ?? "").replace(/\.$/, "");
  if (hostnameRejection(zoneName)) throw new Error("RPZ_ZONE harus berisi nama zona yang valid di .env.");
  const zone = zoneName.toLowerCase() + ".";
  const servers = [rpzServer("RPZ_PRIMARY"), rpzServer("RPZ_SECONDARY")];
  const dig = Bun.which("dig");
  if (!dig) throw new Error("dig tidak ditemukan. Pasang paket dnsutils.");

  for (const server of servers) {
    const endpoint = server.host + " (port " + server.port + ")";
    try {
      console.log("Mengambil zona " + zone + " via AXFR dari " + endpoint + ".");
      return await transferZone(dig, server, zone);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("AXFR gagal dari " + endpoint + " — " + message);
    }
  }
  throw new Error("Kedua server RPZ gagal menyediakan daftar domain yang valid.");
}

async function convert(names: ReadonlySet<string>): Promise<void> {
  const temporaryDir = await mkdtemp(resolve(".domain2lmdb-"));
  const temporaryPath = join(temporaryDir, "blocklist.lmdb");

  try {
    // LMDB v1 requires a fixed map size. Include room for records and tree pages.
    let estimatedBytes = 0;
    for (const name of names) estimatedBytes += name.length + 17;
    const mapSize = 1024 * 1024 + 4 * estimatedBytes;
    const database = lmdb.open({
      path: join(temporaryDir, "working.lmdb"),
      noSubdir: true,
      mapSize,
    });
    try {
      const domains = database.openDB({
        name: "domains",
        keyEncoding: "binary",
        encoding: "binary",
      });
      domains.transactionSync(() => {
        for (const name of names) domains.putSync(toWireKey(name), blockedValue);
      });
      await database.backup(temporaryPath, false);
    } finally {
      await database.close();
    }

    await rename(temporaryPath, outputPath);
  } finally {
    await rm(temporaryDir, { recursive: true, force: true }).catch((error) => {
      console.warn("Direktori sementara gagal dibersihkan —", error.message);
    });
  }
}

try {
  const { version } = lmdb as typeof lmdb & { version: { patch: number } };
  if (version.patch >= 90) {
    throw new Error("Binding LMDB format v1 diperlukan. Jalankan bun install --frozen-lockfile.");
  }

  const domains = await fetchDomains();
  await convert(domains);
  console.log(domains.size + " domain disimpan ke blocklist.lmdb.");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error("Pembuatan blocklist gagal — " + message);
  process.exitCode = 1;
}
