/**
 * Type declaration for the pdfmake PdfPrinter class exported from the
 * `pdfmake/js/printer.js` subpath (not covered by @types/pdfmake which only
 * types the browser/instance API at the package root).
 *
 * The `pdfmake` top-level export (js/index.js) is a runtime *instance*,
 * not the constructor — importing from the subpath is required for Node usage.
 * See: https://github.com/diogenesmendes01/Maia-v2/issues/138
 */
declare module 'pdfmake/js/printer.js' {
  import type { TDocumentDefinitions, TFontDictionary } from 'pdfmake/interfaces';

  interface PdfKitDocument {
    on(event: string, handler: (...args: unknown[]) => void): this;
    end(): void;
  }

  class PdfPrinter {
    constructor(fontDescriptors: TFontDictionary);
    createPdfKitDocument(
      docDefinition: TDocumentDefinitions,
      options?: Record<string, unknown>,
    ): PdfKitDocument;
  }

  export default PdfPrinter;
}
