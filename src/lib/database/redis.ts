import { Redis } from "ioredis";
import dotenv from "dotenv";
dotenv.config();
export const connect = () => {
  try {
    console.log(process.env.REDIS_URL);
    if (!process.env.REDIS_URL) {
      if (process.env.NODE_ENV === "development") {
        console.log("connecting to local redis server...");
        return new Redis();
      }
      throw new Error("redis url is not set");
    }
    return new Redis(process.env.REDIS_URL);
  } catch (error) {
    console.error(error);
  }
};

const redis = connect();
redis?.on("error", (err) => {
  console.error("Redis error:", err);
});
export default redis;
