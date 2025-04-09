import { locations_db } from "./dbconfig";
import { Readable } from "stream";
// SSE Management
export class SSEManager {
  private clients: Map<Symbol, Readable> = new Map();
  private locations: Map<string, LocationData> = new Map();
  private cleanupInterval;
  private logInterval;

  constructor() {
    // Cleanup stale locations every 10 seconds
    this.cleanupInterval = setInterval(() => this.cleanupStaleLocations(), 10000);

    // Log locations to database every 60 seconds
    this.logInterval = setInterval(() => this.logLocationsToDB(), 60000);
  }

  private async cleanupStaleLocations() {
    const now = Date.now();
    const staleTimeout = 10000; // 10 seconds

    for (const [deviceId, data] of this.locations.entries()) {
      if (now - data.timestamp > staleTimeout) {
        console.log("Removing stale location:", deviceId);
        this.locations.delete(deviceId);
      }
    }
  }

  private async logLocationsToDB() {
    const locationDataArray = Array.from(this.locations.values());
    if (locationDataArray.length > 0) {
      try {
        await locations_db.insertMany(locationDataArray);
      } catch (error) {
        console.error("Error logging locations to database:", error);
      }
    }
  }

  addClient(clientId: Symbol, stream: Readable) {
    this.clients.set(clientId, stream);

    // Setup cleanup for this client
    stream.once('end', () => this.removeClient(clientId));
    stream.once('error', () => this.removeClient(clientId));

    // Set maximum listeners to prevent memory leak warnings
    stream.setMaxListeners(15);

    return () => this.removeClient(clientId);
  }

  removeClient(clientId: Symbol) {
    const stream = this.clients.get(clientId);
    if (stream) {
      stream.removeAllListeners();
      stream.destroy();
      this.clients.delete(clientId);
    }
  }

  updateLocation(locationData: LocationData) {
    this.locations.set(locationData.device_id, locationData);
    this.broadcastLocations();
  }

  private broadcastLocations() {
    const locationDataArray = Array.from(this.locations.values());
    const message = `data: ${JSON.stringify(locationDataArray)}\n\n`;

    for (const [clientId, stream] of this.clients.entries()) {
      try {
        if (!stream.destroyed) {
          stream.push(message);
        } else {
          this.removeClient(clientId);
        }
      } catch (error) {
        console.error("Error broadcasting to client:", error);
        this.removeClient(clientId);
      }
    }
  }

  cleanup() {
    clearInterval(this.cleanupInterval);
    clearInterval(this.logInterval);

    for (const [clientId] of this.clients) {
      this.removeClient(clientId);
    }
  }
}

// Types
export interface LocationData {
  device_id: string;
  latitude: number;
  longitude: number;
  body_number: string;
  device_name: string;
  timestamp: number;

  altitude?: number;
  speed?: number;
  course?: number;
  satellites?: number;
  hdop?: number;
  gps_time?: string;
  gps_date?: string;
}


