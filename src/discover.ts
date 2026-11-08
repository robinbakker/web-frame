/**
 * TV discovery — scan local network for Samsung Frame TVs.
 */

import { networkInterfaces } from 'node:os';
import { Socket, isIP } from 'node:net';
import { readTextLimited } from './response-body.js';

export interface DiscoveredTV {
  ip: string;
  port: number;
  model?: string;
  name?: string;
}

/** A host that answered the Samsung TV API as a Samsung TV. */
export interface SamsungTV {
  ip: string;
  model?: string;
  name?: string;
  frameTv: boolean;
}

/**
 * Get all local IP addresses and their subnets for scanning.
 */
function getLocalSubnets(): string[] {
  const interfaces = networkInterfaces();
  const subnets: string[] = [];

  for (const iface of Object.values(interfaces)) {
    if (!iface) continue;
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) {
        // Convert IP to subnet (assume /24 for simplicity)
        const parts = addr.address.split('.');
        subnets.push(`${parts[0]}.${parts[1]}.${parts[2]}.`);
      }
    }
  }

  return [...new Set(subnets)]; // Remove duplicates
}

/**
 * Check if a device at the given IP responds to TV API calls.
 */
async function checkTV(ip: string, port: number = 8001): Promise<DiscoveredTV | null> {
  return new Promise((resolve) => {
    const socket = new Socket();
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(null);
    }, 2000); // 2 second timeout

    socket.connect(port, ip, () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve({ ip, port });
    });

    socket.on('error', () => {
      clearTimeout(timeout);
      resolve(null);
    });
  });
}

/** Every host in the local /24 subnets with port 8001 open. */
async function scanPort8001(log: boolean): Promise<DiscoveredTV[]> {
  const subnets = getLocalSubnets();
  if (subnets.length === 0) {
    throw new Error('No local network interfaces found');
  }

  if (log) console.log(`Scanning local network (${subnets.join(', ')}x.x) for Samsung TVs...`);

  const discovered: DiscoveredTV[] = [];
  const promises: Promise<void>[] = [];

  for (const subnet of subnets) {
    for (let i = 1; i <= 254; i++) {
      const ip = `${subnet}${i}`;
      promises.push(
        checkTV(ip).then((tv) => {
          if (tv) {
            if (log) console.log(`Found potential TV at ${tv.ip}:${tv.port}`);
            discovered.push(tv);
          }
        }),
      );
    }
  }

  await Promise.all(promises);
  return discovered;
}

/**
 * Scan the local network for Samsung Frame TVs.
 * Scans port 8001 (Samsung TV API port) on all IPs in local subnets.
 */
export async function scanForTVs(): Promise<DiscoveredTV[]> {
  return scanPort8001(true);
}

// The answer is untrusted: keep short, printable strings only.
function label(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64);
  return text && text !== 'Unknown' ? text : undefined;
}

/**
 * Asks a host's Samsung TV API (http://<ip>:8001/api/v2/) what it is. Null unless it answers as a
 * Samsung TV. This also tells whether the TV is reachable.
 */
export async function probeSamsungTv(ip: string, timeoutMs = 3000): Promise<SamsungTV | null> {
  if (isIP(ip) !== 4) return null;
  try {
    const response = await fetch(`http://${ip}:8001/api/v2/`, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    });
    try {
      if (response.status !== 200) return null;
      const body = JSON.parse(await readTextLimited(response, 64 * 1024));
      const device = body?.device && typeof body.device === 'object' ? body.device : {};
      if (device.type !== 'Samsung SmartTV' && body?.type !== 'Samsung SmartTV') return null;
      return {
        ip,
        model: label(device.modelName),
        name: label(device.name ?? body.name),
        frameTv: device.FrameTVSupport === 'true',
      };
    } finally {
      await response.body?.cancel().catch(() => undefined);
    }
  } catch {
    return null;
  }
}

/** Like scanForTVs, but only hosts that answer as Samsung TVs, never raw scan results. */
export async function findSamsungTvs(): Promise<SamsungTV[]> {
  const hosts = await scanPort8001(false);
  const tvs = await Promise.all(hosts.map((host) => probeSamsungTv(host.ip)));
  return tvs.filter((tv): tv is SamsungTV => tv !== null);
}
