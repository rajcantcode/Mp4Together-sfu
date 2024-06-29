import * as os from "os";
import { RtpCodecCapability, WorkerSettings } from "mediasoup/node/lib/types";
import { WebRtcTransportOptions } from "mediasoup/node/lib/types";

// This file contains the configurations for mediasoup

const ifaces = os.networkInterfaces();
const getLocalIp = () => {
  console.log("get local ip called");
  let localIp = "127.0.0.1";
  Object.keys(ifaces).forEach((ifname) => {
    // @ts-ignore
    for (const iface of ifaces[ifname]) {
      // Ignore IPv6 and 127.0.0.1
      if (iface.family !== "IPv4" || iface.internal !== false) {
        continue;
      }
      // Set the local ip to the first IPv4 address found and exit the loop
      localIp = iface.address;
      return;
    }
  });
  return localIp;
};
export const config = {
  createWorkerOptions: {
    logLevel: "debug",
    logTags: ["info", "ice", "dtls", "rtp", "srtp", "rtcp"],
    rtcMinPort: 10000,
    rtcMaxPort: 10100,
  } as WorkerSettings,
  mediaCodecs: [
    {
      kind: "audio",
      mimeType: "audio/opus",
      clockRate: 48000,
      channels: 2,
    },
  ] as [RtpCodecCapability],
  createWebRtcTransportOptions: {
    enableTcp: true,
    enableUdp: true,
    preferUdp: true,
    listenInfos: [
      {
        protocol: "udp",
        ip: process.env.SERVER_LISTEN_IP || "0.0.0.0",
        announcedIp: getLocalIp(), // Replace by public Ip, if deploying the server
      },
      {
        protocol: "tcp",
        ip: process.env.SERVER_LISTEN_IP || "0.0.0.0",
        announcedIp: getLocalIp(), // Replace by public Ip, if deploying the server
      },
    ],
  } as WebRtcTransportOptions,
};

// Worker - core
// Router -> worker
// WebRtcTransport -> router
