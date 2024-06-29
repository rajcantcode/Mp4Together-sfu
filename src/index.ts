import * as os from "os";
import { createWorker, getSupportedRtpCapabilities } from "mediasoup";
import {
  AppData,
  Consumer,
  DtlsParameters,
  IceCandidate,
  IceParameters,
  MediaKind,
  Producer,
  Router,
  RtpCodecCapability,
  SctpParameters,
  WebRtcTransport,
  WebRtcTransportOptions,
} from "mediasoup/node/lib/types";
import http from "http";
import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import cookieParser from "cookie-parser";
import { Server } from "socket.io";
import { authenticateToken } from "./helpers.js";
import {
  RtcTransportValidator,
  SocketRoomValidator,
  TransportConnectValidator,
} from "./lib/validators/socketRoom.js";
import { ZodError } from "zod";
import { RtpParameters } from "mediasoup/node/lib/RtpParameters.js";
import { config } from "./config.js";
dotenv.config();
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL,
    credentials: true,
    methods: ["GET", "POST"],
  },
});
app.use(
  cors({
    // @ts-ignore
    origin: [process.env.FRONTEND_URL, process.env.MAIN_SERVER_URL],
    credentials: true, // Allow cookies to be sent with the request
  })
);
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());

interface transportOptions {
  id: string;
  iceParameters: IceParameters;
  iceCandidates: IceCandidate[];
  dtlsParameters: DtlsParameters;
  sctpParameters: SctpParameters | undefined;
}
type ProducerOrConsumer = Producer<AppData> | Consumer<AppData>;
/*{
  roomname:{
    peer 1:{
      ownTransport:{transport:, producer:},
      consumerTransport 1:{transport:, consumer:}
      consumerTransport 2:{transport:, consumer:}
      consumerTransport n:{transport:, consumer:}
    }
    peer 2:{
      ownTransport:
      consumerTransport 1:
      consumer Transport 2:
      consumerTransport n:
    }
  }
} */

interface RoomTransports {
  [roomName: string]: {
    [username: string]: {
      [transportOwner: string]:
        | {
            transport: WebRtcTransport<AppData>;
            producer?: Producer<AppData>;
          }
        | {
            transport: WebRtcTransport<AppData>;
            consumer?: Consumer<AppData>;
          };
    };
  };
}
const roomTransports: RoomTransports = {};
const socketRoomToRouter = new Map<string, Router>();
const socketIdToSocketRoomId = new Map<string, string>();

io.on("connection", async (socket) => {
  const cookies = socket.handshake.headers.cookie;
  const token = cookies?.split("accessToken=")[1].split(";")[0];
  if (!token) {
    socket.disconnect();
    return;
  }
  const isValidToken = await authenticateToken(token);
  if (!isValidToken) {
    socket.disconnect();
    return;
  }
  let socketUser = isValidToken;
  let socketUserRoom: string;

  socket.emit("ready");

  socket.on(
    "getRtpCapabilities",
    async ({ socketRoomId: roomId }, callback) => {
      try {
        const { socketRoomId } = SocketRoomValidator.parse({
          socketRoomId: roomId,
        });
        socketIdToSocketRoomId.set(socket.id, socketRoomId);
        socketUserRoom = socketRoomId;
        const router = socketRoomToRouter.get(socketRoomId);
        if (!router) {
          throw new Error("No router found");
        }
        const rtpCapabilities = router.rtpCapabilities;
        callback({ rtpCapabilities });
      } catch (error) {
        console.error(error);
        if (error instanceof ZodError) {
          callback({ error: { message: error.message } });
          return;
        }
        callback(error);
      }
    }
  );

  socket.on("createRtcTransport", async ({ username, joiner }, callback) => {
    try {
      RtcTransportValidator.parse({ username, joiner });
      console.log(
        "request received to create webRtc transport from " +
          username +
          " for " +
          joiner
      );
      const socketRoomId = socketIdToSocketRoomId.get(socket.id);
      if (!socketRoomId) {
        throw new Error("No associated room found");
      }

      const router = socketRoomToRouter.get(socketRoomId);
      if (!router) {
        throw new Error("No router found");
      }

      const transportOptions = await createWebRtcTransport(
        socketRoomId,
        router,
        username,
        joiner
      );
      callback({ transportOptions });
    } catch (error) {
      console.error(error);
      if (error instanceof ZodError) {
        callback({ error: { message: error.message } });
        return;
      }
      callback(error);
    }
  });

  socket.on(
    "transport-connect",
    ({ dtlsParameters, username, transportOwner }, callback) => {
      try {
        const socketRoomId = socketIdToSocketRoomId.get(socket.id);
        if (!socketRoomId) {
          throw new Error("No associated room found");
        }

        if (
          !checkIfTransportExists(socketRoomId, username, transportOwner) ||
          !dtlsParameters
        ) {
          throw new Error("Invalid details");
        }
        roomTransports[socketRoomId][username][
          transportOwner
        ].transport.connect({
          dtlsParameters,
        });
      } catch (error) {
        console.error(error);
        if (error instanceof ZodError) {
          callback({ error: { msg: error.message } });
          return;
        }
        callback(error);
      }
    }
  );

  socket.on(
    "transport-produce",
    async (
      { transportId, kind, rtpParameters, appData, username },
      callback
    ) => {
      try {
        const socketRoomId = socketIdToSocketRoomId.get(socket.id);
        if (!socketRoomId) {
          throw new Error("No associated room found");
        }
        if (
          !checkIfTransportExists(socketRoomId, username, username) ||
          !kind ||
          !rtpParameters
        ) {
          throw new Error("Invalid details");
        }
        const transport =
          roomTransports[socketRoomId][username][username].transport;
        const producer = await transport.produce({ kind, rtpParameters });

        producer.observer.on("pause", () => {
          console.log("Producer pause event received on the server");
        });
        producer.observer.on("resume", () => {
          console.log("Producer resume event received on the server");
        });
        producer.on("transportclose", () => {
          console.log("transport for this producer closed ");
          producer.close();
        });
        roomTransports[socketRoomId][username][username] = {
          transport,
          producer,
        };

        // Send back to the client the Producer's id
        callback({
          id: producer.id,
        });
      } catch (error) {
        console.error(error);
        callback(error);
      }
    }
  );

  socket.on(
    "consume",
    async ({ rtpCapabilities, producer, username }, callback) => {
      try {
        const socketRoomId = socketIdToSocketRoomId.get(socket.id);
        if (!socketRoomId) {
          throw new Error("No associated room found");
        }

        if (
          !checkIfTransportExists(socketRoomId, producer, producer) &&
          !checkIfTransportExists(socketRoomId, username, producer)
        ) {
          throw new Error("Invalid details");
        }

        const producerId = getProducerId(socketRoomId, producer, producer);
        if (!producerId) {
          throw new Error("No such producer exists");
        }

        const consumerTransport =
          roomTransports[socketRoomId][username][producer].transport;
        if (!consumerTransport) {
          throw new Error("No consumer transport found for " + producer);
        }

        const router = socketRoomToRouter.get(socketRoomId);
        if (!router) {
          throw new Error("No such router exists");
        }
        if (!router.canConsume({ producerId, rtpCapabilities })) {
          throw new Error("Cannot consume " + username);
        }

        const consumer = await consumerTransport.consume({
          producerId,
          rtpCapabilities,
          paused: true,
        });
        consumer.on("transportclose", () => {
          console.log("transport close from consumer");
        });
        consumer.on("producerclose", () => {
          console.log("producer of consumer closed");
          consumerTransport.close();
          consumer.close();
        });
        roomTransports[socketRoomId][username][producer] = {
          transport: consumerTransport,
          consumer,
        };

        const params = {
          id: consumer.id,
          producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        };
        callback(params);
      } catch (error) {
        console.error(error);
        callback({ error });
      }
    }
  );

  socket.on(
    "resume-consumer",
    async ({ username, sender: transportOwner }, callback) => {
      try {
        const socketRoomId = socketIdToSocketRoomId.get(socket.id);
        if (!socketRoomId) {
          throw new Error("No associated room found");
        }
        if (!checkIfTransportExists(socketRoomId, username, transportOwner)) {
          throw new Error("Invalid details");
        }
        const consumer = getConsumer(socketRoomId, username, transportOwner);
        if (!consumer) {
          throw new Error("No consumer found");
        }
        await consumer.resume();
      } catch (error) {
        callback({ error });
      }
    }
  );

  socket.on(
    "pause-consumer",
    async ({ username, transportOwner }, callback) => {
      try {
        const socketRoomId = socketIdToSocketRoomId.get(socket.id);
        if (!socketRoomId) {
          throw new Error("No associated socket Room found");
        }
        if (!checkIfTransportExists(socketRoomId, username, transportOwner)) {
          throw new Error("Invalid details");
        }
        await manageConsumerState(
          socketRoomId,
          username,
          transportOwner,
          "pause"
        );
      } catch (error) {
        console.error(error);
        callback(error);
      }
    }
  );

  socket.on("pause-producer", async ({ username }, callback) => {
    try {
      const socketRoomId = socketIdToSocketRoomId.get(socket.id);
      if (!socketRoomId) {
        throw new Error("No associated room found");
      }
      if (
        !socketRoomId ||
        !username ||
        !checkIfTransportExists(socketRoomId, username, username)
      ) {
        callback({ error: { msg: "Invalid details" } });
      }
      await manageProducerState(socketRoomId, username, username, "pause");
    } catch (error) {
      callback(error);
    }
  });

  socket.on("resume-producer", async ({ username }, callback) => {
    try {
      const socketRoomId = socketIdToSocketRoomId.get(socket.id);
      if (!socketRoomId) {
        throw new Error("No associated room found");
      }
      if (
        !socketRoomId ||
        !username ||
        !checkIfTransportExists(socketRoomId, username, username)
      ) {
        callback({ error: { msg: "Invalid details" } });
      }
      await manageProducerState(socketRoomId, username, username, "resume");
    } catch (error) {
      callback(error);
    }
  });

  // This is for closing all transports of a user when they exit room
  socket.on("close-transports", closeTransports);

  // This is for closing a specific transport of user.
  // Used when someone leaves the room and other participants want to delete that person's transport
  socket.on("close-transport", closeTransport);

  socket.on("disconnect", async (reason) => {
    if (reason !== "client namespace disconnect") {
      await closeTransports({
        leaver: socketUser,
        socketRoomId: socketUserRoom,
      });
    }
    socketIdToSocketRoomId.delete(socket.id);
  });
});

const closeTransport = async ({
  socketRoomId,
  username,
  leaver: transportToDelete,
}: {
  socketRoomId: string;
  username: string;
  leaver: string;
}) => {
  try {
    if (!checkIfTransportExists(socketRoomId, username, transportToDelete)) {
      return { error: { msg: "Invalid data" } };
    }
    roomTransports[socketRoomId][username][transportToDelete].transport.close();
    await manageConsumerState(
      socketRoomId,
      username,
      transportToDelete,
      "close"
    );
    delete roomTransports[socketRoomId][username][transportToDelete];
  } catch (error) {
    console.error(error);
    return { error: { msg: "Internal server error" } };
  }
};
const closeTransports = async ({
  leaver,
  socketRoomId,
}: {
  leaver: string | undefined;
  socketRoomId: string;
}) => {
  try {
    if (Object.keys(roomTransports).length === 0) return;
    if (Object.keys(roomTransports[socketRoomId]).length === 0) {
      delete roomTransports[socketRoomId];
      return;
    }
    // if leaver is not passed, that means the room is deleted, so we need to delete all transports that belonged to that room
    if (!leaver) {
      const peers = Object.keys(roomTransports[socketRoomId]);
      peers.forEach((peer) => {
        const peernames = Object.keys(roomTransports[socketRoomId][peer]);
        peernames.forEach(async (transport) => {
          roomTransports[socketRoomId][peer][transport].transport.close();
          if (peer === transport)
            await manageProducerState(socketRoomId, peer, transport, "close");
          else
            await manageConsumerState(socketRoomId, peer, transport, "close");
        });
      });
      delete roomTransports[socketRoomId];
      return;
    }
    // If the leaver is provided, then we close all of their transports
    const peerTransports = roomTransports[socketRoomId][leaver];
    Object.keys(peerTransports).forEach(async (transportOwner) => {
      peerTransports[transportOwner].transport.close();
      if (transportOwner === leaver)
        await manageProducerState(
          socketRoomId,
          leaver,
          transportOwner,
          "close"
        );
      else
        await manageConsumerState(
          socketRoomId,
          leaver,
          transportOwner,
          "close"
        );
    });
    delete roomTransports[socketRoomId][leaver];
  } catch (error) {
    console.error(error);
  }
};

const checkIfTransportExists = (
  socketRoomId: string,
  username: string,
  transportOwner: string
): boolean => {
  if (
    !roomTransports[socketRoomId] ||
    !roomTransports[socketRoomId][username] ||
    !roomTransports[socketRoomId][username][transportOwner]
  ) {
    return false;
  }
  return true;
};

const worker = await createWorker(config.createWorkerOptions);

// const mediaCodecs: [RtpCodecCapability] = [
//   {
//     kind: "audio",
//     mimeType: "audio/opus",
//     clockRate: 48000,
//     channels: 2,
//   },
// ];

const createWebRtcTransport = async (
  socketRoomId: string,
  router: Router<AppData>,
  username: string,
  joiner: string | undefined
) => {
  const transport = await router.createWebRtcTransport(
    config.createWebRtcTransportOptions
  );
  transport.on("dtlsstatechange", (dtlsState) => {
    if (dtlsState === "closed") {
      transport.close();
    }
  });
  transport.on("@close", () => {
    console.log("WebRTC transport closed");
  });

  // Ahhhh the naming is too confusing, if you have an idea for better naming conventions then please open a new pull request 😭😭😭😭
  const peersTransports = roomTransports[socketRoomId];
  if (!peersTransports[username]) peersTransports[username] = {};
  const peerTransport = peersTransports[username];
  // if (!peerTransport[username]) peerTransport[username] = {transport: };
  if (!joiner) {
    peerTransport[username] = { transport };
  } else {
    peerTransport[joiner] = { transport };
  }

  const { id, iceParameters, iceCandidates, dtlsParameters, sctpParameters } =
    transport;
  const options: transportOptions = {
    id,
    iceParameters,
    iceCandidates,
    dtlsParameters,
    sctpParameters,
  };
  return options;
};

const manageProducerState = async (
  socketRoomId: string,
  username: string,
  transportOwner: string,
  action: "close" | "pause" | "resume"
) => {
  try {
    if (!checkIfTransportExists(socketRoomId, username, transportOwner)) {
      return;
    }

    let transportOwnerWithProducer: {
      transport: WebRtcTransport<AppData>;
      producer?: Producer<AppData>;
    };
    if ("producer" in roomTransports[socketRoomId][username][transportOwner]) {
      transportOwnerWithProducer = roomTransports[socketRoomId][username][
        transportOwner
      ] as {
        transport: WebRtcTransport<AppData>;
        producer?: Producer<AppData>;
      };
    } else {
      throw new Error("No producer for this transport exists");
    }

    if (action === "pause") {
      await transportOwnerWithProducer.producer?.pause();
    } else if (action === "close") {
      transportOwnerWithProducer.producer?.close();
    } else {
      await transportOwnerWithProducer.producer?.resume();
    }
  } catch (error) {
    console.error(error);
  }
};

const manageConsumerState = async (
  socketRoomId: string,
  username: string,
  transportOwner: string,
  action: "close" | "pause" | "resume"
) => {
  try {
    if (!checkIfTransportExists(socketRoomId, username, transportOwner)) {
      return;
    }

    let transportOwnerWithConsumer: {
      transport: WebRtcTransport<AppData>;
      consumer?: Consumer<AppData>;
    };
    if ("consumer" in roomTransports[socketRoomId][username][transportOwner]) {
      transportOwnerWithConsumer = roomTransports[socketRoomId][username][
        transportOwner
      ] as {
        transport: WebRtcTransport<AppData>;
        consumer?: Consumer<AppData>;
      };
    } else {
      throw new Error("No producer for this transport exists");
    }

    if (action === "pause") {
      await transportOwnerWithConsumer.consumer?.pause();
    } else if (action === "close") {
      transportOwnerWithConsumer.consumer?.close();
    } else {
      await transportOwnerWithConsumer.consumer?.resume();
    }
  } catch (error) {
    console.error(error);
  }
};

const getProducerId = (
  socketRoomId: string,
  username: string,
  transportOwner: string
) => {
  if ("producer" in roomTransports[socketRoomId][username][transportOwner]) {
    const transportOwnerWithProducer = roomTransports[socketRoomId][username][
      transportOwner
    ] as {
      transport: WebRtcTransport<AppData>;
      producer?: Producer<AppData>;
    };
    return transportOwnerWithProducer.producer?.id;
  }
};

const getConsumer = (
  socketRoomId: string,
  username: string,
  transportOwner: string
) => {
  if ("consumer" in roomTransports[socketRoomId][username][transportOwner]) {
    const transportOwnerWithConsumer = roomTransports[socketRoomId][username][
      transportOwner
    ] as {
      transport: WebRtcTransport<AppData>;
      consumer?: Consumer<AppData>;
    };
    return transportOwnerWithConsumer.consumer;
  }
};

app.post("/router/create/:socketRoomId", async (req, res) => {
  try {
    const token = req.cookies.accessToken;
    const { socketRoomId } = SocketRoomValidator.parse({
      socketRoomId: req.params.socketRoomId,
    });

    if (!token) {
      return res.status(401).json({ msg: "No token provided" });
    }

    const isValidUser = await authenticateToken(token);
    if (!isValidUser) {
      return res.status(403).json({ msg: "No such user exists" });
    }

    const mediaCodecs = config.mediaCodecs;
    const router: Router = await worker.createRouter({ mediaCodecs });
    roomTransports[socketRoomId] = {};
    socketRoomToRouter.set(socketRoomId, router);
    return res.status(201).json({ msg: "Router created successfully" });
  } catch (error) {
    console.error(error);
    if (error instanceof ZodError) {
      return res.status(401).json({ msg: "Invalid room Id" });
    }
    return res.status(501).json({ msg: "Internal server error" });
  }
});

app.delete("/router/delete/:socketRoomId", async (req, res) => {
  try {
    const { secret } = req.body;
    const { socketRoomId } = SocketRoomValidator.parse({
      socketRoomId: req.params.socketRoomId,
    });
    if (!secret) {
      return res.status(401).json({ msg: "No secret provided" });
    }

    if (secret !== process.env.SFU_SERVER_SECRET) {
      return res.status(403).json({ msg: "Invalid secret" });
    }

    socketRoomToRouter.get(socketRoomId)?.close();
    socketRoomToRouter.delete(socketRoomId);
    await closeTransports({ leaver: undefined, socketRoomId });
    return res.status(204).end();
  } catch (error) {
    console.error(error);
    if (error instanceof ZodError) {
      return res.status(401).json({ msg: "Invalid room Id" });
    }
    return res.status(501).json({ msg: "Internal server error" });
  }
});

server.listen(process.env.PORT, () => {
  console.log("listening on *:", process.env.PORT);
});
