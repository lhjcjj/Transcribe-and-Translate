import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { splitStream } from "../api/client";

const STAGGER_MS = 500;

export type SplitProgress = { current: number; total: number };

function clearAllTimeouts(
  progressRef: React.MutableRefObject<ReturnType<typeof setTimeout>[]>,
  fallbackIdRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>
) {
  progressRef.current.forEach((t) => clearTimeout(t));
  progressRef.current = [];
  if (fallbackIdRef.current != null) {
    clearTimeout(fallbackIdRef.current);
    fallbackIdRef.current = null;
  }
}

export function useSplitFlow(
  uploadId: string | null,
  chunkSizeMin: number,
  onSuccess: (chunks: { upload_id: string }[]) => void,
  onCancel: () => void
) {
  const [isSplitting, setIsSplitting] = useState(false);
  const [splitProgress, setSplitProgress] = useState<SplitProgress | null>(null);
  const splitAbortRef = useRef<AbortController | null>(null);
  const splitProgressTimeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const splitFallbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const splitRevertScheduledRef = useRef(false);
  const splitResultRef = useRef<{ chunks: { upload_id: string }[] } | null>(null);

  useEffect(() => {
    return () => {
      splitAbortRef.current?.abort();
      clearAllTimeouts(splitProgressTimeoutsRef, splitFallbackTimeoutRef);
    };
  }, []);

  const finishSplitAndClearProgress = () => {
    if (splitRevertScheduledRef.current) return;
    splitRevertScheduledRef.current = true;
    const result = splitResultRef.current;
    if (result) onSuccess(result.chunks);
    setIsSplitting(false);
    setSplitProgress(null);
    splitAbortRef.current = null;
    splitResultRef.current = null;
  };

  const doSplit = async () => {
    if (!uploadId) return;
    const controller = new AbortController();
    splitAbortRef.current = controller;
    clearAllTimeouts(splitProgressTimeoutsRef, splitFallbackTimeoutRef);
    splitRevertScheduledRef.current = false;
    splitResultRef.current = null;
    setIsSplitting(true);
    setSplitProgress(null);
    let completed = false;
    try {
      const res = await splitStream(
        uploadId,
        chunkSizeMin,
        (current, total) => {
          if (current === 0) {
            flushSync(() => setSplitProgress({ current, total }));
            return;
          }
          const delayMs = (current - 1) * STAGGER_MS;
          const id = setTimeout(() => {
            flushSync(() => setSplitProgress({ current, total }));
            if (current === total) finishSplitAndClearProgress();
          }, delayMs);
          splitProgressTimeoutsRef.current.push(id);
        },
        controller.signal
      );
      splitResultRef.current = res;
      onSuccess(res.chunks);
      completed = true;
      // Fallback: if stream didn't deliver progress 1..n (e.g. result arrived first), still finish after stagger duration
      const fallbackDelayMs = (res.chunks.length - 1) * STAGGER_MS;
      splitFallbackTimeoutRef.current = setTimeout(() => finishSplitAndClearProgress(), fallbackDelayMs);
    } catch (err) {
      if ((err as Error).name === "AbortError") onCancel();
    } finally {
      if (!completed) {
        clearAllTimeouts(splitProgressTimeoutsRef, splitFallbackTimeoutRef);
        setIsSplitting(false);
        setSplitProgress(null);
        splitAbortRef.current = null;
      }
    }
  };

  return { doSplit, isSplitting, splitProgress, splitAbortRef };
}
