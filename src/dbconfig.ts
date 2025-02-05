import dotenv from "dotenv";
import { MongoClient, Db, Collection, ObjectId } from "mongodb";

dotenv.config();

const uri: string = process.env.MONGODB_URI || '';
// Simplified database connection
let db: Db;
let users: Collection;
let activeSessions: Collection;
let locations: Collection;
// Connect to MongoDB immediately
console.log("Connecting to MongoDB...");
const client = new MongoClient(uri);
client.connect()
  .then(() => {
    console.log("Connected to MongoDB");
    db = client.db('authdb');
    users = db.collection('users');
    activeSessions = db.collection('active_sessions');
    locations = db.collection('locations');
    // Create indexes
    users.createIndex({ email: 1 }, { unique: true });
    users.createIndex({ username: 1 }, { unique: true });
  })
  .catch(error => {
    console.error("MongoDB connection error:", error);
    process.exit(1);
  });

if (!uri) {
  console.error("MONGODB_URI is not defined");
  process.exit(1);
}


export { db, users, activeSessions, ObjectId, client, locations };
