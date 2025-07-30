import ollama from "ollama";
import { join } from "path";

interface TranslatorOptions {
  model: string;
  temperature: number;
  sourceLang: string;
  targetLang: string;
}

export class Translator {
  private options: TranslatorOptions;
  private languageInstructions: string | null = null;

  constructor(options: TranslatorOptions) {
    this.options = options;
    this.loadLanguageInstructions();
  }

  private async loadLanguageInstructions(): Promise<void> {
    try {
      const instructionsPath = join(
        process.cwd(),
        "instructions",
        `${this.options.targetLang}.md`
      );
      const file = Bun.file(instructionsPath);
      if (await file.exists()) {
        this.languageInstructions = await file.text();
        console.log(
          `Loaded language instructions for ${this.options.targetLang}`
        );
      } else {
        console.log(
          `No specific instructions found for ${this.options.targetLang}`
        );
      }
    } catch (error) {
      console.error(
        `Error loading language instructions for ${this.options.targetLang}:`,
        error
      );
    }
  }

  async translateText(text: string): Promise<string> {
    if (!text.trim()) return text;
    try {
      let prompt = `Translate: "${text}" from ${this.options.sourceLang} to ${this.options.targetLang}.`;

      if (this.languageInstructions) {
        prompt += `\n\nFollow these language-specific guidelines:\n${this.languageInstructions}`;
      }

      prompt += `\n\nRespond with only the translation.`;

      const response = await ollama.generate({
        model: this.options.model,
        prompt: prompt,
        options: {
          temperature: this.options.temperature,
        },
      });
      console.log(
        `Translated text ${text} to ${
          this.options.targetLang
        }: ${response.response.trim()}`
      );
      return response.response.trim();
    } catch (error) {
      console.error(`Translation error for text: "${text}"`, error);
      throw error;
    }
  }
}
