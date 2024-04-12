import { RtpParameters } from "mediasoup/node/lib/fbs/rtp-parameters.js";
import { DtlsParameters } from "mediasoup/node/lib/fbs/web-rtc-transport.js";
import { z } from "zod";

export const SocketRoomValidator = z.object({
  socketRoomId: z.string().length(8, "Invalid socket room id"),
});

export const RtcTransportValidator = z.object({
  username: z.string().min(4, "Invalid username"),
  joiner: z.string().min(4, "Invalid joiner"),
});

export const TransportConnectValidator = z.object({
  dtlsParameters: z.unknown().refine((value) => {
    if (!value || typeof value !== "object") {
      return false;
    }
    if (
      "role" in value &&
      "fingerprints" in value &&
      Array.isArray(value.fingerprints)
    ) {
      return true;
    }
  }, "Invalid dtlsParameters"),
  username: z.string().min(4, "Invalid username"),
  transportOwner: z.string().min(4, "Invalid transport owner"),
});

export const TransportProduceValidator = z.object({
  transportId: z.string(),
  kind: z.string().refine((value) => {
    return ["audio", "video"].includes(value);
  }, "Invalid kind"),
  rtpParameters: z.unknown().refine((value) => {
    return value instanceof RtpParameters;
  }),
  appData: z.unknown(),
  username: z.string().min(4, "Invalid username"),
});
