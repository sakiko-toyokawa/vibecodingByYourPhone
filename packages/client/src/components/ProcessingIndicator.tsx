import { memo, useEffect, useMemo, useState } from "react";
import { getFunPhrasesEnabled } from "../hooks/useFunPhrases";
import { ThinkingIndicator } from "./ThinkingIndicator";

const PROCESSING_PHRASES = [
  "Thinking...",
  "Processing...",
  "Cooking...",
  "Analyzing...",
  "Working on it...",
  "Pondering...",
  "Computing...",
  "Crafting...",
  "Mulling it over...",
  "On it...",
  "Crunching...",
  "Brewing...",
  "Conjuring...",
  "Synthesizing...",
  "Deliberating...",
  "Ruminating...",
  "Contemplating...",
  "Percolating...",
  "Cogitating...",
  "Noodling...",
];

const ROTATION_INTERVAL_MS = 2000;
const TYPEWRITER_SPEED_MS = 25; // ~40 chars/second = ~240 WPM

/** Fisher-Yates shuffle */
function shuffle<T>(array: T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = result[i];
    result[i] = result[j] as T;
    result[j] = temp as T;
  }
  return result;
}

interface Props {
  isProcessing: boolean;
}

export const ProcessingIndicator = memo(function ProcessingIndicator({
  isProcessing,
}: Props) {
  const [phraseIndex, setPhraseIndex] = useState(0);
  const [displayedText, setDisplayedText] = useState("");
  const [isTyping, setIsTyping] = useState(true);

  // Check setting and shuffle phrases when processing starts
  const phrases = useMemo(() => {
    if (!isProcessing) return ["Thinking..."];
    const funEnabled = getFunPhrasesEnabled();
    if (!funEnabled) return ["Thinking..."];
    return shuffle(PROCESSING_PHRASES);
  }, [isProcessing]);

  // Rotate phrases
  useEffect(() => {
    if (!isProcessing) {
      setPhraseIndex(0);
      setDisplayedText("");
      setIsTyping(true);
      return;
    }

    const interval = setInterval(() => {
      setPhraseIndex((prev) => (prev + 1) % phrases.length);
      setIsTyping(true);
      setDisplayedText("");
    }, ROTATION_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [isProcessing, phrases.length]);

  // Typewriter effect
  useEffect(() => {
    if (!isProcessing || !isTyping) return;

    const phrase = phrases[phraseIndex] ?? "";
    if (displayedText.length >= phrase.length) {
      setIsTyping(false);
      return;
    }

    const timeout = setTimeout(() => {
      setDisplayedText(phrase.slice(0, displayedText.length + 1));
    }, TYPEWRITER_SPEED_MS);

    return () => clearTimeout(timeout);
  }, [isProcessing, isTyping, phraseIndex, displayedText, phrases]);

  if (!isProcessing) {
    return null;
  }

  return (
    <div className="processing-indicator">
      <div className="processing-dot-container">
        <ThinkingIndicator />
      </div>
      <span className="processing-text">
        {displayedText}
        <span className="processing-cursor">|</span>
      </span>
    </div>
  );
});
