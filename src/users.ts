// auth.ts (server-side)
import { Elysia, t } from 'elysia';
import { ObjectId } from 'mongodb';
import { jwt } from '@elysiajs/jwt';
import { users, activeSessions } from "./dbconfig";

export const authService = new Elysia({ name: 'auth/service' })
  .use(jwt({
    name: 'jwt',
    secret: process.env.JWT_SECRET || 'iTrack',
    sameSite: 'Lax',
  }))
  .macro({
    isAuthenticated(enabled = true) {
      if (!enabled) return;

      return {
        beforeHandle: async ({ headers, jwt, set }) => {
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
            if (!session) throw new Error('Session expired');

            // Set user context
            const user = await users.findOne(
              { _id: new ObjectId(payload.id) },
              { projection: { password: 0 } }
            );

            if (!user) throw new Error('User not found');

            // Return both user and token
            return { user, token };
          } catch (error) {
            set.status = 401;
            return {
              status: "error",
              message: "Unauthorized"
            };
          }
        }
      };
    }
  });

export const auth = new Elysia({ prefix: '/auth' })
  .use(authService)

  // Register route with proper error handling for DB connection
  .post("/register", async ({ body, set }) => {
    const { name, username, email, password, phone, avatar, address, account_type, subscription } = body;

    try {
      // Check if users collection is defined
      if (!users) {
        console.error("MongoDB collection 'users' is not initialized");
        set.status = 500;
        return {
          status: "error",
          message: "Database connection not ready"
        };
      }

      const existingUser = await users.findOne({
        $or: [{ email }, { username }]
      });

      if (existingUser) {
        set.status = 400;
        return {
          status: "error",
          message: "User already exists"
        };
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
        status: "success",
        message: "User registered successfully",
        user: newUser
      };
    } catch (error) {
      console.error("Registration error:", error);
      set.status = 500;
      return {
        status: "error",
        message: error instanceof Error ? error.message : "Database error"
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
    })
  })

  // Login route
  .post("/login", async ({ body, jwt, headers, set }) => {
    const { username, password } = body;

    try {
      // Check if collections are initialized
      if (!users || !activeSessions) {
        set.status = 500;
        return {
          status: "error",
          message: "Database connection not ready"
        };
      }

      const user = await users.findOne({ username });

      if (!user) {
        set.status = 400;
        return {
          status: "error",
          message: "Can't find that user"
        };
      }

      const isValid = await Bun.password.verify(password, user.password);
      if (!isValid) {
        set.status = 400;
        return {
          status: "error",
          message: "Wrong password"
        };
      }

      // Remove existing sessions for this user
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
        status: "success",
        message: "Login successful",
        token,
        user: safeUser
      };
    } catch (error) {
      console.error("Login error:", error);
      set.status = 500;
      return {
        status: "error",
        message: "Login failed"
      };
    }
  }, {
    body: t.Object({
      username: t.String(),
      password: t.String(),
    })
  })

  // Logout route - Extract token from headers
  .post("/logout", async ({ headers, set }) => {
    try {
      if (!activeSessions) {
        set.status = 500;
        return {
          status: "error",
          message: "Database connection not ready"
        };
      }

      const authHeader = headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        set.status = 401;
        return {
          status: "error",
          message: "Unauthorized"
        };
      }

      const token = authHeader.split(' ')[1];
      await activeSessions.deleteOne({ token });

      return {
        status: "success",
        message: "Logout successful"
      };
    } catch (error) {
      console.error("Logout error:", error);
      set.status = 500;
      return {
        status: "error",
        message: "Logout failed"
      };
    }
  })


  .post("/change-password", async ({ body, set }) => {
    const { username, old_password, new_password } = body;
    try {
      if (!users) {
        set.status = 500;
        return {
          status: "error",
          message: "Database connection not ready"
        };
      }

      const user = await users.findOne({ username });
      if (!user) {
        set.status = 400;
        return {
          status: "error",
          message: "User not found"
        };
      }

      const isValid = await Bun.password.verify(old_password, user.password);
      if (!isValid) {
        set.status = 400;
        return {
          status: "error",
          message: "Invalid old password"
        };
      }

      const hashedPassword = await Bun.password.hash(new_password);
      await users.updateOne({ username }, { $set: { password: hashedPassword } });

      return {
        status: "success",
        message: "Password changed successfully"
      };
    } catch (error) {
      console.error("Change password error:", error);
      set.status = 500;
      return {
        status: "error",
        message: "Password change failed"
      };
    }
  }, {
    body: t.Object({
      username: t.String(),
      old_password: t.String(),
      new_password: t.String(),
    }),
  })

export default auth;
