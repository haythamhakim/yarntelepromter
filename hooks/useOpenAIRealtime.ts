"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  eventToTranscriptUpdate,
  safeParseRealtimeEvent,
  type TranscriptUpdate,
} from "@/lib/realtime/events";
import {
  buildAlignmentPrompt,
  parseAlignmentResponse,
  type AlignmentCandidate,
  type AlignmentResponse,
} from "@/lib/teleprompter/semanticAligner";

type RealtimeStatus = "idle" | "connecting" | "connected" | "error";

type SessionResponse = {
  clientSecret: string;
  model: string;
};

type UseOpenAIRealtimeOptions = {
  scriptLanguage?: string;
};

export function useOpenAIRealtime(options: UseOpenAIRealtimeOptions = {}) {
  const { scriptLanguage = "en" } = options;
  const [status, setStatus] = useState<RealtimeStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [updates, setUpdates] = useState<TranscriptUpdate[]>([]);
  const [speechLevel, setSpeechLevel] = useState(0);
  const [lastEventType, setLastEventType] = useState<string>("");
  const [eventCount, setEventCount] = useState(0);

  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const analyserDataRef = useRef<Uint8Array | null>(null);
  const levelRafRef = useRef<number | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const alignmentResolverRef = useRef<((value: AlignmentResponse | null) => void) | null>(null);
  const alignmentTextBufferRef = useRef<string>("");
  const alignmentResponseInFlightRef = useRef(false);

  const cleanup = useCallback(() => {
    if (levelRafRef.current !== null) {
      window.cancelAnimationFrame(levelRafRef.current);
      levelRafRef.current = null;
    }

    const sourceNode = sourceNodeRef.current;
    if (sourceNode) {
      sourceNode.disconnect();
      sourceNodeRef.current = null;
    }

    const analyser = analyserRef.current;
    if (analyser) {
      analyser.disconnect();
      analyserRef.current = null;
    }
    analyserDataRef.current = null;

    const audioContext = audioContextRef.current;
    if (audioContext) {
      void audioContext.close();
      audioContextRef.current = null;
    }

    const channel = dataChannelRef.current;
    if (channel) {
      channel.close();
      dataChannelRef.current = null;
    }

    const connection = peerConnectionRef.current;
    if (connection) {
      connection.getSenders().forEach((sender) => sender.track?.stop());
      connection.close();
      peerConnectionRef.current = null;
    }

    const stream = streamRef.current;
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    alignmentResolverRef.current = null;
    alignmentTextBufferRef.current = "";
    alignmentResponseInFlightRef.current = false;
    setSpeechLevel(0);
  }, []);

  const handleDataChannelMessage = useCallback((event: MessageEvent<unknown>) => {
    const parsed = safeParseRealtimeEvent(typeof event.data === "string" ? event.data : "");
    if (!parsed || !parsed.type) {
      return;
    }
    setLastEventType(parsed.type);
    setEventCount((previous) => previous + 1);

    if (process.env.NODE_ENV === "development") {
      console.debug("[rt-event]", parsed.type, parsed);
    }

    if (parsed.type === "error") {
      const msg = typeof parsed.error === "object" && parsed.error
        ? String((parsed.error as { message?: unknown }).message ?? JSON.stringify(parsed.error))
        : JSON.stringify(parsed);
      const normalized = msg.toLowerCase();
      const isActiveResponseError =
        normalized.includes("active response in progress") ||
        normalized.includes("conversation already has an active response");
      if (isActiveResponseError) {
        if (process.env.NODE_ENV === "development") {
          console.warn("[rt-warn] Active response already in progress. Skipping duplicate request.");
        }
        return;
      }
      console.error("[rt-error]", msg);
      setError(msg);
      return;
    }

    const transcriptUpdate = eventToTranscriptUpdate(parsed);
    if (transcriptUpdate) {
      setUpdates((previous) => [...previous.slice(-120), transcriptUpdate]);
      return;
    }

    if (parsed.type === "response.output_text.delta" || parsed.type === "response.text.delta") {
      const delta = typeof parsed.delta === "string" ? parsed.delta : "";
      alignmentTextBufferRef.current += delta;
      return;
    }

    if (
      parsed.type === "response.output_text.done" ||
      parsed.type === "response.text.done" ||
      parsed.type === "response.done"
    ) {
      const doneText = typeof parsed.text === "string" ? parsed.text : "";
      const combined = `${alignmentTextBufferRef.current}${doneText}`;
      alignmentTextBufferRef.current = "";

      const resolver = alignmentResolverRef.current;
      if (resolver) {
        alignmentResolverRef.current = null;
        resolver(parseAlignmentResponse(combined));
      }
      alignmentResponseInFlightRef.current = false;
    }
  }, []);

  const sendEvent = useCallback((payload: object) => {
    const channel = dataChannelRef.current;
    if (!channel || channel.readyState !== "open") {
      return false;
    }
    channel.send(JSON.stringify(payload));
    return true;
  }, []);

  const start = useCallback(async () => {
    if (status === "connecting" || status === "connected") {
      return;
    }

    setStatus("connecting");
    setError(null);
    setUpdates([]);
    setLastEventType("");
    setEventCount(0);

    try {
      const sessionResponse = await fetch("/api/realtime/session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          scriptLanguage,
        }),
      });

      if (!sessionResponse.ok) {
        throw new Error("Unable to create Realtime session.");
      }

      const { clientSecret, model } = (await sessionResponse.json()) as SessionResponse;
      if (!clientSecret || !model) {
        throw new Error("Realtime session response is incomplete.");
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      const sourceNode = audioContext.createMediaStreamSource(stream);
      sourceNodeRef.current = sourceNode;
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.25;
      analyserRef.current = analyser;
      sourceNode.connect(analyser);
      analyserDataRef.current = new Uint8Array(analyser.frequencyBinCount);

      const readLevel = () => {
        const activeAnalyser = analyserRef.current;
        const data = analyserDataRef.current;
        if (!activeAnalyser || !data) {
          return;
        }

        activeAnalyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i += 1) {
          const centered = (data[i] - 128) / 128;
          sum += centered * centered;
        }
        const rms = Math.sqrt(sum / data.length);
        const normalized = Math.min(1, rms * 6.5);
        setSpeechLevel((previous) => previous * 0.65 + normalized * 0.35);
        levelRafRef.current = window.requestAnimationFrame(readLevel);
      };
      levelRafRef.current = window.requestAnimationFrame(readLevel);

      const peerConnection = new RTCPeerConnection();
      peerConnectionRef.current = peerConnection;

      peerConnection.ontrack = (trackEvent) => {
        const audio = document.createElement("audio");
        audio.srcObject = trackEvent.streams[0];
        audio.muted = true;
        audio.autoplay = true;
      };

      stream.getTracks().forEach((track) => peerConnection.addTrack(track, stream));

      const dataChannel = peerConnection.createDataChannel("oai-events");
      dataChannelRef.current = dataChannel;
      dataChannel.addEventListener("message", handleDataChannelMessage);
      dataChannel.addEventListener("open", () => {
        setStatus("connected");
        sendEvent({
          type: "session.update",
          session: {
            modalities: ["text", "audio"],
            turn_detection: { type: "server_vad" },
            input_audio_transcription: {
              model: "gpt-4o-mini-transcribe",
              language: scriptLanguage,
            },
            instructions:
              "You are a silent transcription assistant. Do NOT respond or speak. Just listen.",
          },
        });
      });

      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);

      const sdpResponse = await fetch(
        `https://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${clientSecret}`,
            "Content-Type": "application/sdp",
          },
          body: offer.sdp,
        },
      );

      if (!sdpResponse.ok) {
        throw new Error("Failed to establish Realtime connection.");
      }

      const answer = await sdpResponse.text();
      await peerConnection.setRemoteDescription({
        type: "answer",
        sdp: answer,
      });
    } catch (caughtError) {
      cleanup();
      setStatus("error");
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Unexpected error while connecting to Realtime.",
      );
    }
  }, [cleanup, handleDataChannelMessage, scriptLanguage, sendEvent, status]);

  const stop = useCallback(() => {
    cleanup();
    setStatus("idle");
  }, [cleanup]);

  const requestSemanticAlignment = useCallback(
    async (
      transcriptWindow: string,
      candidates: AlignmentCandidate[],
    ): Promise<AlignmentResponse | null> => {
      if (!transcriptWindow.trim() || candidates.length === 0) {
        return null;
      }

      const channel = dataChannelRef.current;
      if (!channel || channel.readyState !== "open") {
        return null;
      }

      if (alignmentResolverRef.current || alignmentResponseInFlightRef.current) {
        return null;
      }

      const prompt = buildAlignmentPrompt(transcriptWindow, candidates);
      return new Promise<AlignmentResponse | null>((resolve) => {
        alignmentResolverRef.current = resolve;
        alignmentTextBufferRef.current = "";

        const conversationCreated = sendEvent({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: prompt }],
          },
        });

        const responseCreated = sendEvent({
          type: "response.create",
          response: {
            modalities: ["text"],
            max_output_tokens: 140,
            instructions:
              'Return strict JSON only. Schema: {"bestChunkId":"chunk-id-or-null","confidence":0..1,"notes":"short"}',
          },
        });

        if (!conversationCreated || !responseCreated) {
          alignmentResolverRef.current = null;
          resolve(null);
          return;
        }
        alignmentResponseInFlightRef.current = true;

        window.setTimeout(() => {
          if (alignmentResolverRef.current) {
            alignmentResolverRef.current = null;
            resolve(null);
          }
        }, 1200);
        window.setTimeout(() => {
          alignmentResponseInFlightRef.current = false;
        }, 5000);
      });
    },
    [sendEvent],
  );

  useEffect(() => {
    return () => cleanup();
  }, [cleanup]);

  return {
    status,
    error,
    updates,
    speechLevel,
    lastEventType,
    eventCount,
    start,
    stop,
    requestSemanticAlignment,
  };
}
