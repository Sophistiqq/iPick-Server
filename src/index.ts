import cors from "@elysiajs/cors";
import swagger from "@elysiajs/swagger";
import { Elysia, t } from "elysia";
import jwt from "@elysiajs/jwt";
import { users, activeSessions, locations_db } from "./dbconfig";
import { ObjectId } from "mongodb";
import os from "os"
import nodemailer from "nodemailer";
const port = process.env.PORT || 3000;
const locations = new Map(); // Key: device_id, Value: { latitude, longitude, timestamp }
import { LocationData, SSEManager } from "./SSEManager";
import { Readable } from "stream";


// Email setup
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  }
});

let otps = new Map(); // Key: email, Value: otp
// Create SSE manager instance
const sseManager = new SSEManager();
// Function to log locations to the database

setInterval(async () => {
  const locationDataArray = Array.from(locations.values());
  if (locationDataArray.length > 0) {
    await locations_db.insertMany(locationDataArray); // Log to database
  }
}, 60000); // Log every 60 seconds

const app = new Elysia()
  .use(cors({
    origin: "*",
  }))
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
    const { name, username, email, password, phone, avatar, address, account_type, subscription } = body;
    console.log("Registration request:", body);
    try {
      const existingUser = await users.findOne({
        $or: [{ email }, { username }]
      });

      if (existingUser) {
        return { message: "User already exists", status: "error" };
      }
      const hashedPassword = await Bun.password.hash(password);

      const result = await users.insertOne({
        name,
        username,
        email,
        phone,
        avatar,
        address,
        account_type,
        subscription,
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
      name: t.String(),
      username: t.String(),
      email: t.String(),
      password: t.String(),
      phone: t.String(),
      avatar: t.String(),
      address: t.String(),
      account_type: t.String(),
      subscription: t.Optional(t.Object({
        type: t.String(),
        status: t.String(),
        start_date: t.String(),
        expires_at: t.String(),
        device_allowed: t.Number(),
      }))
    }),
  })


  .post("/login", async ({ body, jwt, headers }) => {
    const { username, password } = body;

    try {
      const user = await users.findOne({ username });

      if (!user) {
        return { message: "Can't find that user", status: "error" };
      }

      const isValid = await Bun.password.verify(password, user.password);
      if (!isValid) {
        return { message: "Wrong password", status: "error" };
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
      return {
        message: "Login successful",
        token,
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
    const { device_id, latitude, longitude, device_name, body_number } = body;
    console.log("Location received:", body);
    if (!device_id || !latitude || !longitude) {
      return { error: "Missing GPS data" };
    }

    const locationData: LocationData = {
      device_id,
      latitude,
      longitude,
      device_name,
      body_number,
      timestamp: Date.now(),
    };

    sseManager.updateLocation(locationData);

    return { message: "Location received", status: "success" };
  }, {
    body: t.Object({
      device_id: t.String(),
      latitude: t.Number(),
      longitude: t.Number(),
      device_name: t.String(),
      body_number: t.String(),
    }),
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
  // Get all locations, it contains _id, device_id, latitude, longitude, timestamp
  .get("/unit-history", async () => {
    const latestLocations = await locations_db.aggregate([
      { $sort: { timestamp: -1 } },
      { $group: { _id: "$device_id", latestLocation: { $first: "$$ROOT" } } },
      { $replaceRoot: { newRoot: "$latestLocation" } }
    ]).toArray();
    return { locations: latestLocations };
  })

  .post("/change-password", async ({ body }) => {
    const { username, old_password, new_password } = body;
    console.log("Change password request:", body);
    try {
      const user = await users.findOne({ username });
      if (!user) {
        return { error: "User not found", status: "error" };
      }

      const isValid = await Bun.password.verify(old_password, user.password);
      if (!isValid) {
        return { error: "Invalid old password", status: "error" };
      }

      const hashedPassword = await Bun.password.hash(new_password);
      await users.updateOne({ username }, { $set: { password: hashedPassword } });

      return { message: "Password changed successfully", status: "success" };
    } catch (error) {
      console.error("Change password error:", error);
      return { error: "Password change failed", status: "error" };
    }
  }, {
    body: t.Object({
      username: t.String(),
      old_password: t.String(),
      new_password: t.String(),
    }),
  })
  .post("/get-unit-details", async ({ body }) => {
    const { device_id } = body;
    const devices = await locations_db.aggregate([
      { $match: { device_id } },
      {
        $group: {
          _id: "$device_id",  // Group by device_id instead of _id
          device_name: { $first: "$device_name" },
          body_number: { $first: "$body_number" },
          logs: {
            $push: { latitude: "$latitude", longitude: "$longitude", timestamp: "$timestamp" }
          }
        }
      }
    ]).toArray();
    return { devices };
  }, {
    body: t.Object({
      device_id: t.String(),
    }),
  })
  .get("/get-dashboard-data", () => {
    let serverStatus = {
      SystemUptime: (process.uptime() / 60).toFixed(2) + " minutes",
      RAM: os.freemem() / (1024 ** 3),
      ServerName: os.hostname(),
      ServerIp: os.networkInterfaces(),
      CPU: os.loadavg(),
    }
    return { serverStatus }
  })
  .group("/forgot-password", group => {
    return group
      .post("/check-email", async ({ body }) => {
        const { email } = body;
        const user = await users.findOne({ email });
        if (!user) {
          return { message: "User not found", status: "error" };
        } else {
          return { message: "Valid Email, Proceed to Step 2", status: "success" };
        }
      }, {
        body: t.Object({
          email: t.String()
        })
      })
      .post("/send-otp", async ({ body }) => {
        const { email } = body;
        if (!email) return { success: false, message: "Email is required" };

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        otps.set(email, otp);
        try {
          const mailOptions = {
            from: `"iTrack Team" <no-reply@gmail.com>`,
            to: email,
            replyTo: "no-reply@gmail.com",
            subject: "Your OTP Code",
            text: `Your OTP code is: ${otp}`,
            html: `Your OTP code is: <b>${otp}</b>`,
          };

          await transporter.sendMail(mailOptions);
          //console.log("OTP Sent:", info);
          return { status: "success", message: "OTP sent successfully" };
        } catch (error) {
          console.error("Error sending OTP:", error);
          return { status: "success", message: "Failed to send OTP" };
        }
      }, {
        body: t.Object({
          email: t.String(),
        })
      })
      .post("/verify-otp", async ({ body }) => {
        const { email, otp } = body;
        if (!email || !otp) return { success: false, message: "Email and OTP are required" };

        const storedOtp = otps.get(email);
        if (otp !== storedOtp) {
          return { success: false, message: "Invalid OTP" };
        }

        return { status: "success", message: "OTP verified successfully" };
      }, {
        body: t.Object({
          email: t.String(),
          otp: t.String(),
        })
      })
      .post("/reset-password", async ({ body }) => {
        const { email, password } = body;
        if (!email || !password) return { success: false, message: "Email and password are required" };

        const hashedPassword = await Bun.password.hash(password);
        await users.updateOne({ email }, { $set: { password: hashedPassword } });

        return { status: "success", message: "Password reset successfully" };
      }, {
        body: t.Object({
          email: t.String(),
          password: t.String(),
        })
      })
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
  `Elysia is running at ${app.server?.hostname}:${port}`
);
