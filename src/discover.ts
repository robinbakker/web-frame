/**
 * TV discovery — scan local network for Samsung Frame TVs.
 */

import { networkInterfaces } from 'node:os';
import { Socket } from 'node:net';

export interface DiscoveredTV {
  ip: string;
  port: number;
  model?: string;
  name?: string;
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

/**
 * Scan the local network for Samsung Frame TVs.
 * Scans port 8001 (Samsung TV API port) on all IPs in local subnets.
 */
export async function scanForTVs(): Promise<DiscoveredTV[]> {
  const subnets = getLocalSubnets();
  if (subnets.length === 0) {
    throw new Error('No local network interfaces found');
  }

  console.log(`Scanning local network (${subnets.join(', ')}x.x) for Samsung TVs...`);

  const discovered: DiscoveredTV[] = [];
  const promises: Promise<void>[] = [];

  for (const subnet of subnets) {
    for (let i = 1; i <= 254; i++) {
      const ip = `${subnet}${i}`;
      promises.push(
        checkTV(ip).then((tv) => {
          if (tv) {
            console.log(`Found potential TV at ${tv.ip}:${tv.port}`);
            discovered.push(tv);
          }
        }),
      );
    }
  }

  await Promise.all(promises);
  return discovered;
}
