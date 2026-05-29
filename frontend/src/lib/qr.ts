import QRCodeLib from "qrcode";

type QrOptions = {
  cellSize?: number;
  margin?: number;
};

export async function qrToDataUrl(text: string, _opts: QrOptions = {}): Promise<string> {
  return QRCodeLib.toDataURL(text, {
    width: 400,
    margin: 2,
    color: {
      dark: "#000000",
      light: "#ffffff",
    },
    errorCorrectionLevel: "M",
  });
}
