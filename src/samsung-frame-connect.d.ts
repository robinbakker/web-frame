declare module 'samsung-frame-connect/endpoints/art-mode.js' {
  import { EventEmitter } from 'node:events';
  export class ArtModeEndpoint extends EventEmitter {
    constructor(options: {
      host: string;
      name?: string;
      verbosity?: number;
      responseTimeout?: number;
    });
    connect(): Promise<void>;
    close(): void;
    inArtMode(): Promise<boolean>;
    getAPIVersion(): Promise<string>;
    getAvailableArt(): Promise<import('samsung-frame-connect').ArtItem[]>;
    getCurrentArt(): Promise<import('samsung-frame-connect').ArtItem>;
    upload(
      buffer: Buffer,
      options: { fileType?: string; matteType?: string; matteColor?: string },
    ): Promise<string | undefined>;
    setCurrentArt(options: { id: string; category?: string }): Promise<void>;
    deleteArt(ids: string | string[]): Promise<Array<{ id: string }>>;
    request(params: {
      action: string;
      [key: string]: unknown;
    }): Promise<Record<string, unknown>>;
  }
}

declare module 'samsung-frame-connect' {
  import { EventEmitter } from 'node:events';
  export class SamsungFrameClient extends EventEmitter {
    constructor(options: {
      host: string;
      name?: string;
      services?: string[];
      verbosity?: number;
    });
    connect(): Promise<void>;
    close(): Promise<void>;
    // Art mode
    inArtMode(): Promise<boolean>;
    getAPIVersion(): Promise<string>;
    getAvailableArt(): Promise<ArtItem[]>;
    getCurrentArt(): Promise<ArtItem>;
    upload(
      buffer: Buffer,
      options: { fileType?: string; matteType?: string; matteColor?: string },
    ): Promise<string | undefined>;
    setCurrentArt(options: { id: string; category?: string }): Promise<void>;
    deleteArt(ids: string | string[]): Promise<Array<{ id: string }>>;
    getArtModeInfo(): Promise<Record<string, unknown>>;
    // Device
    getDeviceInfo(): Promise<Record<string, unknown>>;
    isOn(): Promise<boolean>;
    // Low-level
    request(params: {
      action: string;
      [key: string]: unknown;
    }): Promise<Record<string, unknown>>;
  }
  export interface ArtItem {
    id: string;
    width?: number;
    height?: number;
    matte: { type: string; color: string } | null;
    date?: Date;
    categoryId?: string;
    slideshow?: boolean;
  }
}
