declare const qrcode: {
  create(text: string, options?: { errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H' }): {
    modules: { size: number; data: ArrayLike<number | boolean> };
  };
};

export default qrcode;
