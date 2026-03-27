"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  DEFAULT_TRANSCRIPTION_LANGUAGE,
  DEFAULT_TRANSCRIPTION_MODEL,
} from "@/lib/realtime/config";
import {
  eventToTranscriptUpdate,
  extractRealtimeAlignmentDoneText,
  extractRealtimeAlignmentTextDelta,
  extractRealtimeErrorMessage,
  hasRealtimeAudioContent,
  isRealtimeAlignmentTextDeltaEvent,
  isRealtimeAlignmentTextDoneEvent,
  isRealtimeErrorEvent,
  isRealtimeInputSpeechStartedEvent,
  isRealtimeOutputItemAddedEvent,
  isRealtimeOutputItemDoneEvent,
  isRealtimeRateLimitsUpdatedEvent,
  isRealtimeResponseCreatedEvent,
  isRealtimeResponseDoneEvent,
  isRealtimeResponseInterruptedEvent,
  isRealtimeTranscriptionCompletedEvent,
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

type UsageSnapshot = {
  responseCount: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  transcriptionAudioTokens: number;
};

type RateLimitSnapshot = {
  at: number;
  details: unknown;
};

type UseOpenAIRealtimeOptions = {
  scriptLanguage?: string;
  scriptText?: string;
};

export function useOpenAIRealtime(options: UseOpenAIRealtimeOptions = {}) {
  const { scriptLanguage = "en", scriptText } = options;
  const [status, setStatus] = useState<RealtimeStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [updates, setUpdates] = useState<TranscriptUpdate[]>([]);
  const [speechLevel, setSpeechLevel] = useState(0);
  const [usage, setUsage] = useState<UsageSnapshot>({
    responseCount: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    transcriptionAudioTokens: 0,
  });
  const [latestRateLimits, setLatestRateLimits] =
    useState<RateLimitSnapshot | null>(null);
  const [mediaStream, setMediaStream] = useState<MediaStream | null>(null);

  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const analyserDataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const levelRafRef = useRef<number | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const alignmentResolverRef = useRef<
    ((value: AlignmentResponse | null) => void) | null
  >(null);
  const alignmentTextBufferRef = useRef<string>("");
  const alignmentResponseInFlightRef = useRef(false);
  const alignmentResolveTimeoutRef = useRef<number | null>(null);
  const alignmentInflightResetTimeoutRef = useRef<number | null>(null);
  const eventCounterRef = useRef(0);
  const pendingClientEventsRef = useRef<Map<string, string>>(new Map());
  const activeResponseRef = useRef(false);
  const activeResponseItemIdRef = useRef<string | null>(null);
  const activeResponseHasAudioOutputRef = useRef(false);
  const lastPartialUpdateAtRef = useRef(0);

  const clearAlignmentTimers = useCallback(() => {
    if (alignmentResolveTimeoutRef.current !== null) {
      window.clearTimeout(alignmentResolveTimeoutRef.current);
      alignmentResolveTimeoutRef.current = null;
    }
    if (alignmentInflightResetTimeoutRef.current !== null) {
      window.clearTimeout(alignmentInflightResetTimeoutRef.current);
      alignmentInflightResetTimeoutRef.current = null;
    }
  }, []);

  const cleanup = useCallback(() => {
    clearAlignmentTimers();

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
      channel.onmessage = null;
      channel.onopen = null;
      channel.onclose = null;
      channel.onerror = null;
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

    const pendingAlignmentResolver = alignmentResolverRef.current;
    alignmentResolverRef.current = null;
    if (pendingAlignmentResolver) {
      pendingAlignmentResolver(null);
    }
    alignmentTextBufferRef.current = "";
    alignmentResponseInFlightRef.current = false;
    pendingClientEventsRef.current.clear();
    activeResponseRef.current = false;
    activeResponseItemIdRef.current = null;
    activeResponseHasAudioOutputRef.current = false;
    setSpeechLevel(0);
    setMediaStream(null);
  }, [clearAlignmentTimers]);

  const handleDataChannelMessage = useCallback(
    (event: MessageEvent<unknown>) => {
      const parsed = safeParseRealtimeEvent(
        typeof event.data === "string" ? event.data : "",
      );
      if (!parsed) {
        return;
      }

      if (isRealtimeErrorEvent(parsed)) {
        const msg = extractRealtimeErrorMessage(parsed);
        const normalized = msg.toLowerCase();
        const isActiveResponseError =
          normalized.includes("active response in progress") ||
          normalized.includes("conversation already has an active response");
        if (isActiveResponseError) {
          return;
        }
        const sourceEvent = parsed.event_id
          ? pendingClientEventsRef.current.get(parsed.event_id)
          : undefined;
        if (sourceEvent && parsed.event_id) {
          pendingClientEventsRef.current.delete(parsed.event_id);
        }
        const decoratedMessage = sourceEvent
          ? `${msg} (originated from "${sourceEvent}")`
          : msg;
        const isBenignInterruptionRace =
          normalized.includes(
            "cancellation failed: no active response found",
          ) ||
          normalized.includes(
            "only model output audio messages can be truncated",
          );
        if (isBenignInterruptionRace) {
          return;
        }
        setError(decoratedMessage);
        return;
      }

      if (
        isRealtimeInputSpeechStartedEvent(parsed) &&
        activeResponseRef.current &&
        activeResponseHasAudioOutputRef.current
      ) {
        const channel = dataChannelRef.current;
        if (channel && channel.readyState === "open") {
          channel.send(JSON.stringify({ type: "response.cancel" }));
        }

        if (activeResponseItemIdRef.current) {
          if (channel && channel.readyState === "open") {
            channel.send(
              JSON.stringify({
                type: "conversation.item.truncate",
                item_id: activeResponseItemIdRef.current,
                content_index: 0,
                audio_end_ms: 0,
              }),
            );
          }
        }
      }

      if (isRealtimeResponseCreatedEvent(parsed)) {
        activeResponseRef.current = true;
        activeResponseHasAudioOutputRef.current = false;
      }

      if (isRealtimeOutputItemAddedEvent(parsed)) {
        const itemId = parsed.item?.id;
        if (itemId) {
          activeResponseItemIdRef.current = itemId;
        }
        if (hasRealtimeAudioContent(parsed.item)) {
          activeResponseHasAudioOutputRef.current = true;
        }
      }

      if (isRealtimeOutputItemDoneEvent(parsed)) {
        const itemId = parsed.item?.id;
        if (itemId && itemId === activeResponseItemIdRef.current) {
          activeResponseItemIdRef.current = null;
        }
      }

      if (isRealtimeResponseDoneEvent(parsed)) {
        activeResponseRef.current = false;
        activeResponseItemIdRef.current = null;
        activeResponseHasAudioOutputRef.current = false;
        const usagePayload = parsed.response?.usage;
        if (usagePayload) {
          const cachedTokens =
            usagePayload.input_token_details?.cached_tokens ?? 0;
          setUsage((previous) => ({
            responseCount: previous.responseCount + 1,
            totalTokens:
              previous.totalTokens + (usagePayload.total_tokens ?? 0),
            inputTokens:
              previous.inputTokens + (usagePayload.input_tokens ?? 0),
            outputTokens:
              previous.outputTokens + (usagePayload.output_tokens ?? 0),
            cachedInputTokens: previous.cachedInputTokens + cachedTokens,
            transcriptionAudioTokens: previous.transcriptionAudioTokens,
          }));
        }

        const metadata = parsed.response?.metadata as
          | Record<string, unknown>
          | undefined;
        if (metadata?.topic === "alignment") {
          alignmentResponseInFlightRef.current = false;
        }
      }

      if (isRealtimeResponseInterruptedEvent(parsed)) {
        activeResponseRef.current = false;
        activeResponseItemIdRef.current = null;
        activeResponseHasAudioOutputRef.current = false;
      }

      if (isRealtimeTranscriptionCompletedEvent(parsed)) {
        const audioTokens =
          parsed.usage?.input_token_details?.audio_tokens ?? 0;
        if (audioTokens > 0) {
          setUsage((previous) => ({
            ...previous,
            transcriptionAudioTokens:
              previous.transcriptionAudioTokens + audioTokens,
          }));
        }
      }

      if (isRealtimeRateLimitsUpdatedEvent(parsed)) {
        setLatestRateLimits({
          at: Date.now(),
          details: parsed.rate_limits,
        });
      }

      const transcriptUpdate = eventToTranscriptUpdate(parsed);
      if (transcriptUpdate) {
        const now = Date.now();
        if (
          transcriptUpdate.kind === "partial" &&
          now - lastPartialUpdateAtRef.current < 5
        ) {
          return;
        }
        if (transcriptUpdate.kind === "partial") {
          lastPartialUpdateAtRef.current = now;
        }
        setUpdates((previous) => {
          const next = previous.slice(-120);
          const last = next[next.length - 1];
          if (transcriptUpdate.kind === "partial" && last?.kind === "partial") {
            if (last.text === transcriptUpdate.text) {
              return previous;
            }
            next[next.length - 1] = transcriptUpdate;
            return next;
          }
          if (
            last &&
            last.kind === transcriptUpdate.kind &&
            last.text === transcriptUpdate.text
          ) {
            return previous;
          }
          next.push(transcriptUpdate);
          return next;
        });
        return;
      }

      if (isRealtimeAlignmentTextDeltaEvent(parsed)) {
        const delta = extractRealtimeAlignmentTextDelta(parsed);
        alignmentTextBufferRef.current += delta;
        return;
      }

      if (isRealtimeAlignmentTextDoneEvent(parsed)) {
        const doneText = extractRealtimeAlignmentDoneText(parsed);
        const combined = `${alignmentTextBufferRef.current}${doneText}`;
        alignmentTextBufferRef.current = "";

        const resolver = alignmentResolverRef.current;
        if (resolver) {
          clearAlignmentTimers();
          alignmentResolverRef.current = null;
          resolver(parseAlignmentResponse(combined));
        }
        alignmentResponseInFlightRef.current = false;
      }
    },
    [clearAlignmentTimers],
  );

  const sendEvent = useCallback((payload: Record<string, unknown>) => {
    const channel = dataChannelRef.current;
    if (!channel || channel.readyState !== "open") {
      return false;
    }

    const candidateEventId = payload.event_id;
    const eventId =
      typeof candidateEventId === "string" && candidateEventId.trim()
        ? candidateEventId
        : `client_evt_${Date.now()}_${eventCounterRef.current++}`;
    const enrichedPayload = {
      ...payload,
      event_id: eventId,
    };

    pendingClientEventsRef.current.set(
      eventId,
      String(payload.type ?? "unknown"),
    );
    if (pendingClientEventsRef.current.size > 200) {
      const oldest = pendingClientEventsRef.current.keys().next().value;
      if (oldest) {
        pendingClientEventsRef.current.delete(oldest);
      }
    }
    channel.send(JSON.stringify(enrichedPayload));
    return true;
  }, []);

  const start = useCallback(async () => {
    if (status === "connecting" || status === "connected") {
      return;
    }

    setStatus("connecting");
    setError(null);
    setUpdates([]);
    setLatestRateLimits(null);
    setUsage({
      responseCount: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      transcriptionAudioTokens: 0,
    });

    try {
      const sessionResponse = await fetch("/api/realtime/session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          scriptLanguage,
          scriptText,
        }),
      });

      if (!sessionResponse.ok) {
        throw new Error("Unable to create Realtime session.");
      }

      const { clientSecret, model } =
        (await sessionResponse.json()) as SessionResponse;
      if (!clientSecret || !model) {
        throw new Error("Realtime session response is incomplete.");
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      setMediaStream(stream);

      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      const sourceNode = audioContext.createMediaStreamSource(stream);
      sourceNodeRef.current = sourceNode;
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.25;
      analyserRef.current = analyser;
      sourceNode.connect(analyser);
      analyserDataRef.current = new Uint8Array(
        new ArrayBuffer(analyser.frequencyBinCount),
      );

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

      stream
        .getTracks()
        .forEach((track) => peerConnection.addTrack(track, stream));

      const dataChannel = peerConnection.createDataChannel("oai-events");
      dataChannelRef.current = dataChannel;
      dataChannel.onmessage = handleDataChannelMessage;
      dataChannel.onopen = () => {
        setStatus("connected");
        sendEvent({
          type: "session.update",
          session: {
            type: "realtime",
            output_modalities: ["text"],
            audio: {
              input: {
                turn_detection: {
                  type: "server_vad",
                  threshold: 0.35,
                  prefix_padding_ms: 350,
                  silence_duration_ms: 700,
                  create_response: false,
                  interrupt_response: true,
                },
                transcription: {
                  model: DEFAULT_TRANSCRIPTION_MODEL,
                  language: DEFAULT_TRANSCRIPTION_LANGUAGE,
                },
              },
            },
          },
        });
      };

      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);

      const sdpResponse = await fetch(
        "https://api.openai.com/v1/realtime/calls",
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

      const location = sdpResponse.headers.get("Location");
      const callId = location?.split("/").pop();
      if (callId) {
        void fetch("/api/realtime/sideband/bootstrap", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            callId,
            scriptLanguage,
            scriptText,
          }),
        }).catch(() => {});
      }
    } catch (caughtError) {
      cleanup();
      setStatus("error");
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Unexpected error while connecting to Realtime.",
      );
    }
  }, [
    cleanup,
    handleDataChannelMessage,
    scriptLanguage,
    scriptText,
    sendEvent,
    status,
  ]);

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

      if (
        alignmentResolverRef.current ||
        alignmentResponseInFlightRef.current
      ) {
        return null;
      }

      const prompt = buildAlignmentPrompt(transcriptWindow, candidates);
      return new Promise<AlignmentResponse | null>((resolve) => {
        clearAlignmentTimers();
        alignmentResolverRef.current = resolve;
        alignmentTextBufferRef.current = "";

        const responseCreated = sendEvent({
          type: "response.create",
          response: {
            conversation: "none",
            output_modalities: ["text"],
            metadata: { topic: "alignment" },
            input: [
              {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: prompt }],
              },
            ],
            max_output_tokens: 140,
            instructions:
              'Return strict JSON only. Schema: {"bestChunkId":"chunk-id-or-null","confidence":0..1,"notes":"short"}',
          },
        });

        if (!responseCreated) {
          alignmentResolverRef.current = null;
          resolve(null);
          return;
        }
        alignmentResponseInFlightRef.current = true;

        alignmentResolveTimeoutRef.current = window.setTimeout(() => {
          if (alignmentResolverRef.current) {
            alignmentResolverRef.current = null;
            resolve(null);
          }
          alignmentResolveTimeoutRef.current = null;
        }, 1200);
        alignmentInflightResetTimeoutRef.current = window.setTimeout(() => {
          alignmentResponseInFlightRef.current = false;
          alignmentInflightResetTimeoutRef.current = null;
        }, 2000);
      });
    },
    [clearAlignmentTimers, sendEvent],
  );

  useEffect(() => {
    return () => cleanup();
  }, [cleanup]);

  return {
    status,
    error,
    updates,
    speechLevel,
    mediaStream,
    usage,
    latestRateLimits,
    start,
    stop,
    requestSemanticAlignment,
  };
}
