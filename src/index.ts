import cors from "@elysiajs/cors";
import swagger from "@elysiajs/swagger";
import { Elysia, t } from "elysia";
import jwt from "@elysiajs/jwt";
import { users, activeSessions, locations, drivers } from "./dbconfig";
import { Readable } from "stream"
import { ObjectId } from "mongodb";

const port = process.env.PORT || 3000;
const clients = new Set<any>();
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
    return new Readable({
      async read() {
        const interval = setInterval(async () => {
          // Retrieve all location data as an array
          const locationDataArray = await locations.find().toArray();
          // Send the locations data to the client
          locationDataArray.forEach(locationData => {
            this.push(`data: ${JSON.stringify(locationData)}\n\n`);
          });
        }, 3000);
        setTimeout(() => {
          clearInterval(interval);
          this.push(null); // End the stream
        }, 5000);
      }
    });
  })


  // Endpoint to Receive GPS Data from ESP32
  .post("/location", async ({ body }) => {
    const { device_id, latitude, longitude } = body;
    console.log("Location data received:", body);
    if (!device_id || !latitude || !longitude) {
      return { error: "Missing GPS data" };
    }

    const locationData = {
      device_id,
      latitude,
      longitude,
      timestamp: new Date(),
    };

    // Save to database (update if exists, otherwise insert)
    await locations.updateOne(
      { device_id },
      { $set: locationData },
      { upsert: true }
    );

    // Broadcast to all SSE clients
    const message = `data: ${JSON.stringify(locationData)}\n\n`;
    clients.forEach((client) => client.send(message));

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
  .listen(port);

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${port}`
);
