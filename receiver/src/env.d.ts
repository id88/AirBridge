/// <reference types="vite/client" />

declare global {
  const __SINGLE_FILE_BUILD__: boolean | undefined;

  interface DetectedBarcode {
    rawValue: string;
    format: string;
    boundingBox?: DOMRectReadOnly;
  }

  interface BarcodeDetectorInstance {
    detect(image: ImageBitmapSource): Promise<DetectedBarcode[]>;
  }

  interface BarcodeDetectorConstructor {
    new (options?: { formats?: string[] }): BarcodeDetectorInstance;
    getSupportedFormats(): Promise<string[]>;
  }

  interface Window {
    BarcodeDetector?: BarcodeDetectorConstructor;
  }
}

export {};
