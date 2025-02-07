import cors from "@elysiajs/cors";
import swagger from "@elysiajs/swagger";
import { Elysia, t } from "elysia";
import jwt from "@elysiajs/jwt";
import { users, activeSessions, locations_db, drivers } from "./dbconfig";
import { Readable } from "stream";
import { ObjectId } from "mongodb";
const port = process.env.PORT || 3000;
const locations = new Map(); // Key: device_id, Value: { latitude, longitude, timestamp }

// SSE Management
class SSEManager {
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
    const staleTimeout = 30000; // 30 seconds

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
        console.log("Locations logged to database:", locationDataArray.length);
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
interface LocationData {
  device_id: string;
  latitude: number;
  longitude: number;
  timestamp: number;
}

// Create SSE manager instance
const sseManager = new SSEManager();


// Function to remove stale locations
setInterval(() => {
  const now = Date.now();
  locations.forEach((value: { timestamp: number; }, device_id: any) => {
    if (now - value.timestamp > 30000) { // 30 seconds expiry
      console.log("Removing stale location:", device_id);
      locations.delete(device_id);
    }
  });
}, 10000); // Check every 10 seconds

// Function to log locations to the database
setInterval(async () => {
  const locationDataArray = Array.from(locations.values());
  if (locationDataArray.length > 0) {
    await locations_db.insertMany(locationDataArray); // Log to database
    console.log("Locations logged to database:", locationDataArray.length);
  }
}, 60000); // Log every 60 seconds

const app = new Elysia()
  .use(cors())
  .use(swagger({
    documentation: {
      info: {
        title: "Elysia API",
        description: "API documentation for Elysia",
        version: "1.0.0",
      },
    }
  }))
  .use(
    jwt({
      name: "jwt",
      secret: process.env.JWT_SECRET || "secret",
      sameSite: "Lax",
      inject: true,
    })
  )
  .post("/register", async ({ body }) => {
    const { fullname, username, email, mobile_number, password } = body;

    try {
      const existingUser = await users.findOne({
        $or: [{ email }, { username }]
      });

      if (existingUser) {
        return { error: "User already exists", status: "error" };
      }

      const hashedPassword = await Bun.password.hash(password);

      const result = await users.insertOne({
        fullname,
        username,
        email,
        mobile_number,
        password: hashedPassword,
        created_at: new Date(),
        updated_at: new Date()
      });

      const newUser = await users.findOne(
        { _id: result.insertedId },
        { projection: { password: 0 } }
      );

      return {
        message: "User registered successfully",
        user: newUser,
        status: "success"
      };
    } catch (error) {
      console.error("Registration error:", error);
      return {
        error: error instanceof Error ? error.message : "Database error",
        status: "error"
      };
    }
  }, {
    body: t.Object({
      fullname: t.String(),
      username: t.String(),
      email: t.String(),
      mobile_number: t.String(),
      password: t.String(),
    }),
  })

  .post("/register-driver", async ({ body }) => {
    const { fullname, username, email, mobile_number, device_id, password, plate_number } = body;
    try {
      const existingUser = await users.findOne({
        $or: [{ email }, { username }]
      });

      if (existingUser) {
        return { error: "User already exists", status: "error" };
      }
      const hashedPassword = await Bun.password.hash(password);

      await drivers.insertOne({
        fullname,
        username,
        email,
        mobile_number,
        device_id,
        plate_number,
        password: hashedPassword,
        created_at: new Date(),
        updated_at: new Date()
      });

      return {
        message: "Driver registered successfully",
        status: "success"
      };
    } catch (error) {
      console.error("Registration error:", error);
      return {
        error: error instanceof Error ? error.message : "Database error",
        status: "error"
      };
    }
  }, {
    body: t.Object({
      fullname: t.String(),
      username: t.String(),
      email: t.String(),
      mobile_number: t.String(),
      device_id: t.String(),
      password: t.String(),
      plate_number: t.String(),
    })
  })

  .post("/login", async ({ body, jwt, headers }) => {
    const { username, password } = body;

    try {
      const user = await users.findOne({ username });

      if (!user) {
        return { error: "Invalid credentials", status: "error" };
      }

      const isValid = await Bun.password.verify(password, user.password);
      if (!isValid) {
        return { error: "Invalid credentials", status: "error" };
      }

      await activeSessions.deleteMany({ user_id: user._id });

      const token = await jwt.sign({
        id: user._id.toString(),
        email: user.email,
        exp: Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60)
      });

      await activeSessions.insertOne({
        user_id: user._id,
        token,
        device_info: headers["user-agent"] || "unknown",
        created_at: new Date()
      });

      const { password: _, ...safeUser } = user;
      const userType = user.plate_number ? "driver" : "user";
      return {
        message: "Login successful",
        token,
        userType,
        user: safeUser,
        status: "success"
      };
    } catch (error) {
      console.error("Login error:", error);
      return {
        error: "Login failed",
        status: "error"
      };
    }
  }, {
    body: t.Object({
      username: t.String(),
      password: t.String(),
    })
  })

  .get("/me", async ({ headers, jwt, set }) => {
    const authHeader = headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      set.status = 401;
      return { error: "Unauthorized" };
    }

    const token = authHeader.split(' ')[1];
    try {
      const payload = await jwt.verify(token);
      if (!payload) throw new Error('Invalid token');

      const session = await activeSessions.findOne({ token });
      if (!session) {
        set.status = 401;
        return { error: "Session expired or invalid" };
      }

      const user = await users.findOne(
        { _id: new ObjectId(payload.id) },
        { projection: { password: 0 } }
      );

      if (!user) throw new Error('User not found');
      return { user };
    } catch (error) {
      set.status = 401;
      return { error: "Invalid or expired token" };
    }
  })

  .post("/logout", async ({ headers }) => {
    const authHeader = headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return { error: "Unauthorized" };
    }

    const token = authHeader.split(' ')[1];
    await activeSessions.deleteOne({ token });
    return { message: "Logout successful" };
  })

  .get("/users", async () => {
    const allUsers = await users.find({}, {
      projection: { password: 0 }
    }).toArray();
    return { users: allUsers };
  })
  .get("/", () => "Hello Elysia")

  .get("/events", ({ set }) => {
    set.headers["Content-Type"] = "text/event-stream";
    set.headers["Cache-Control"] = "no-cache";
    set.headers["Connection"] = "keep-alive";

    const clientId = Symbol();
    const readable = new Readable({
      read() { } // Implementation moved to SSEManager
    });

    // Add client to SSE manager
    const cleanup = sseManager.addClient(clientId, readable);

    // Ensure cleanup happens
    readable.on('close', cleanup);

    return readable;
  })

  .post("/location", async ({ body }) => {
    const { device_id, latitude, longitude } = body;
    console.log("Location data received:", body);

    if (!device_id || !latitude || !longitude) {
      return { error: "Missing GPS data" };
    }

    const locationData: LocationData = {
      device_id,
      latitude,
      longitude,
      timestamp: Date.now(),
    };

    sseManager.updateLocation(locationData);

    return { message: "Location received", status: "success" };
  }, {
    body: t.Object({
      device_id: t.String(),
      latitude: t.Number(),
      longitude: t.Number(),
    }),
  })
  .get("/page/unit-management", async () => {
    const allDrivers = await drivers.find().toArray();
    return { drivers: allDrivers };
  })
  .get("/page/user-data:username", async ({ params }) => {
    const { username } = params;
    const user = await users.findOne({ username });
    return { user };
  }, {
    params: t.Object({
      username: t.String(),
    }),
  })

  .listen(port);
// Cleanup on process termination
process.on('SIGTERM', () => {
  sseManager.cleanup();
  process.exit(0);
});

process.on('SIGINT', () => {
  sseManager.cleanup();
  process.exit(0);
});
console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${port}`
);
