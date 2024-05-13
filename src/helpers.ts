import jwt from "jsonwebtoken";
import { User } from "./model/User.js";
import redis from "./lib/database/redis.js";

export const authenticateToken = async (token: string): Promise<boolean> => {
  const secret = process.env.ACCESS_TOKEN_SECRET;
  if (!secret) {
    throw new Error("ACCESS_TOKEN_SECRET is not set");
  }
  try {
    const payload = await jwt.verify(token, secret);
    if (typeof payload === "object" && "name" in payload) {
      const user =
        (await redis?.hgetall(
          `${payload.guest ? `guest` : `user`}:${payload.name}`
        )) || (await User.findOne({ username: payload.name }));
      if (!user) {
        return false;
      }
      return true;
    }
    return false;
  } catch (error) {
    console.log(error);
    return false;
  }
};
