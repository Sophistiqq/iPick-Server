import dotenv from "dotenv";
import { MongoClient, Db, Collection, ObjectId } from "mongodb";

dotenv.config();

const uri: string = process.env.MONGODB_URI || '';
// Database variables
let db: Db;
let users: Collection;
let activeSessions: Collection;
let locations_db: Collection;

if (!uri) {
  console.error("MONGODB_URI is not defined");
  process.exit(1);
}

// Create a connection promise
export const dbConnected = new Promise<void>((resolve, reject) => {
  console.log("Connecting to MongoDB...");
  const client = new MongoClient(uri);
  client.connect()
    .then(() => {
      console.log("Connected to MongoDB");
      db = client.db('authdb');
      users = db.collection('users');
      activeSessions = db.collection('active_sessions');
      locations_db = db.collection('locations');

      // Create indexes
      return Promise.all([
        users.createIndex({ email: 1 }, { unique: true }),
        users.createIndex({ username: 1 }, { unique: true })
      ]);
    })
    .then(() => {
      console.log("Database indexes created");
      resolve();
    })
    .catch(error => {
      console.error("MongoDB connection error:", error);
      reject(error);
    });
});

export { db, users, activeSessions, ObjectId, locations_db };
