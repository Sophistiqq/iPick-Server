import cors from "@elysiajs/cors";
import swagger from "@elysiajs/swagger";
import jwt from "@elysiajs/jwt";
import { Elysia, t } from "elysia";
import dotenv from "dotenv";
import { MongoClient, Db, Collection, ObjectId } from "mongodb";

dotenv.config();

// MongoDB setup
const uri: any = process.env.MONGODB_URI;
if (!uri) {
  throw new Error("MONGODB_URI must be defined in .env file");
}
const port = process.env.PORT || 3000;
class DatabaseConnection {
  private client: MongoClient;
  public db: Db | any;
  public users: Collection | any;
  public activeSessions: Collection | any;

  constructor() {
    this.client = new MongoClient(uri);
  }

  async connect() {
    try {
      await this.client.connect();
      this.db = this.client.db(process.env.MONGODB_DBNAME || 'authdb');

      // Create collections and indexes
      this.users = this.db.collection('users');
      this.activeSessions = this.db.collection('active_sessions');

      // Create unique index for email
      await this.users.createIndex({ email: 1 }, { unique: true });
      await this.users.createIndex({ username: 1 }, { unique: true });

      console.log("MongoDB connected successfully");
    } catch (error) {
      console.error("MongoDB connection error:", error);
      process.exit(1);
    }
  }

  async close() {
    await this.client.close();
  }
}

const dbConnection = new DatabaseConnection();

const app = new Elysia()
  .use(cors({
    origin: "*",
    credentials: true,
  }))
  .use(swagger())
  .use(
    jwt({
      name: "jwt",
      secret: process.env.JWT_SECRET || "secret",
      sameSite: "Lax",
    })
  )
  .onBeforeHandle(async () => {
    // Ensure database connection before any route handler
    if (!dbConnection.db) {
      await dbConnection.connect();
    }
  })
  .post("/register", async ({ body }) => {
    const { fullname, username, email, mobile_number, password } = body;

    try {
      // Check if user already exists
      const existingUser = await dbConnection.users.findOne({
        $or: [{ email }, { username }]
      });

      if (existingUser) {
        return { error: "User already exists", status: "error" };
      }

      // Hash password
      const hashedPassword = await Bun.password.hash(password);

      // Insert new user
      const result = await dbConnection.users.insertOne({
        fullname,
        username,
        email,
        mobile_number,
        password: hashedPassword,
        created_at: new Date(),
        updated_at: new Date()
      });

      // Fetch the newly created user
      const newUser = await dbConnection.users.findOne(
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

  .post("/login", async ({ body, jwt, headers }) => {
    const { username, password } = body;

    try {
      const user = await dbConnection.users.findOne({ username });

      if (!user) {
        return { error: "Invalid credentials", status: "error" };
      }

      const isValid = await Bun.password.verify(password, user.password);
      if (!isValid) {
        return { error: "Invalid credentials", status: "error" };
      }

      // Check for existing sessions
      const existingSession = await dbConnection.activeSessions.findOne({
        user_id: user._id
      });

      if (existingSession) {
        // Option 2: Force logout other sessions
        await dbConnection.activeSessions.deleteMany({ user_id: user._id });
        console.log("Logged out from other devices");
      }

      const token = await jwt.sign({
        id: user._id.toString(),
        email: user.email,
        exp: Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60)
      });

      // Store new session
      await dbConnection.activeSessions.insertOne({
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

      // Check if session exists
      const session = await dbConnection.activeSessions.findOne({ token });

      if (!session) {
        set.status = 401;
        return { error: "Session expired or invalid" };
      }

      const user = await dbConnection.users.findOne(
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

    // Remove session from database
    await dbConnection.activeSessions.deleteOne({ token });

    return { message: "Logout successful" };
  }, {
    headers: t.Object({
      authorization: t.String(),
    })
  })

  // Get all users
  .get("/users", async () => {
    const users = await dbConnection.users.find({}, {
      projection: { password: 0 }
    }).toArray();
    return { users };
  })

  // Root endpoint
  .get("/", () => "Hello Elysia")
  .listen(port);

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`
);

// Graceful shutdown
process.on('SIGINT', async () => {
  await dbConnection.close();
  process.exit(0);
});
