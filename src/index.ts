import cors from "@elysiajs/cors";
import swagger from "@elysiajs/swagger";
import { Elysia, t } from "elysia";
import jwt from "@elysiajs/jwt";
import { dbConnected, locations_db, users } from './dbconfig';
import os from "os"
import nodemailer from "nodemailer";
const port = process.env.PORT || 3000;
const locations = new Map(); // Key: device_id, Value: { latitude, longitude, timestamp }
import { LocationData, SSEManager } from "./SSEManager";
import { Readable } from "stream";
import { auth } from "./users";


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



dbConnected
  .then(() => {
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
          sameSite: "None",
          inject: true,
        })
      )
      // User authentication and authorization routes
      .use(auth)

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
        console.log("Location received:", body);

        // Check if we have the nested structure
        const device_info = body.device_info;
        const gps_data = body.gps_data;

        if (!device_info || !gps_data || !gps_data.latitude || !gps_data.longitude) {
          return { error: "Missing GPS data" };
        }

        const locationData: LocationData = {
          device_id: device_info.device_id,
          latitude: gps_data.latitude,
          longitude: gps_data.longitude,
          device_name: device_info.device_name,
          body_number: device_info.body_number,
          timestamp: Date.now(),
          // Add additional fields from the GPS data
          altitude: gps_data.altitude,
          speed: gps_data.speed,
          course: gps_data.course,
          satellites: gps_data.satellites,
          hdop: gps_data.hdop,
          gps_time: gps_data.time,
          gps_date: gps_data.date
        };

        sseManager.updateLocation(locationData);
        return { message: "Location received", status: "success" };
      }, {
        body: t.Object({
          device_info: t.Object({
            device_id: t.String(),
            body_number: t.String(),
            device_name: t.String()
          }),
          gps_data: t.Object({
            latitude: t.Number(),
            longitude: t.Number(),
            altitude: t.Optional(t.Number()),
            speed: t.Optional(t.Number()),
            course: t.Optional(t.Number()),
            satellites: t.Optional(t.Number()),
            hdop: t.Optional(t.Number()),
            date: t.Optional(t.String()),
            time: t.Optional(t.String())
          })
        })
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
    console.log(`Server is running at ${app.server?.hostname}:${app.server?.port}`);

  })
  .catch(error => {
    console.error("Failed to start server:", error);
    process.exit(1);
  });
