import type { ProviderId } from './providers';

/**
 * What a chat model can take as input. Providers do not publish this in one place, so it is decided per model
 * from the provider's own model list data when it carries it (Anthropic does), otherwise from the model name.
 * Rules err on the side of "no": a wrong "no" only means a fallback is used, a wrong "yes" means a failed request.
 */
export interface ModelCaps {
  /** Reads images (screenshots, photos). */
  vision: boolean;
  /** Reads PDFs natively. */
  pdf: boolean;
  /** Understands audio itself, so a voice note needs no separate speech-to-text service. */
  audioIn: boolean;
}

export const NO_CAPS: ModelCaps = { vision: false, pdf: false, audioIn: false };

/** Capability fields as some model lists return them (Anthropic: capabilities.image_input.supported etc.). */
export interface ListedCaps { image_input?: { supported?: boolean }; pdf_input?: { supported?: boolean } }

const NOT_CHAT = /(embed|tts|whisper|transcribe|moderation|imagen|veo|image-generation|dall-e|realtime|search-preview|computer-use|-audio-|gpt-audio)/i;

export function modelCaps(provider: ProviderId, model: string, listed?: ListedCaps): ModelCaps {
  const m = model.toLowerCase().replace(/^models\//, '');
  if (!m || NOT_CHAT.test(m)) return NO_CAPS;
  switch (provider) {
    case 'anthropic': {
      if (listed?.image_input || listed?.pdf_input) return { vision: listed.image_input?.supported === true, pdf: listed.pdf_input?.supported === true, audioIn: false };
      const modern = /^claude-(3|opus|sonnet|haiku|fable|\d)/.test(m);
      return { vision: modern, pdf: modern, audioIn: false };
    }
    case 'openai': {
      const vision = /^(gpt-4o|gpt-4\.1|gpt-4\.5|gpt-5|chatgpt-4o|o1(?!-mini|-preview)|o3|o4)/.test(m) || /^gpt-4-turbo/.test(m);
      // Chat audio input needs wav/mp3 and WhatsApp voice notes are ogg/opus, so OpenAI uses its transcription endpoint instead.
      return { vision, pdf: vision, audioIn: false };
    }
    case 'gemini': {
      const gem = /^gemini-/.test(m) && !/(embedding|aqa)/.test(m);
      return { vision: gem, pdf: gem, audioIn: gem };
    }
    case 'deepseek':
      return NO_CAPS; // deepseek-chat / deepseek-reasoner take text only
  }
}

/** Plain-language summary for the settings screen. */
export function describeCaps(c: ModelCaps): string {
  const yes = [c.vision && 'images', c.pdf && 'PDF files', c.audioIn && 'voice notes'].filter(Boolean) as string[];
  const no = [!c.vision && 'images', !c.pdf && 'PDF files', !c.audioIn && 'voice notes'].filter(Boolean) as string[];
  return `${yes.length ? `Understands: ${yes.join(', ')}.` : 'Text only.'}${no.length && yes.length ? ` Not: ${no.join(', ')}.` : ''}`;
}
