const maxIconSize = 2 * 1024 * 1024;

export async function readApplicationIcon(file: File): Promise<string> {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (!extension || !["png", "svg", "ico"].includes(extension)) throw new Error("图标格式只支持 PNG、SVG 或 ICO。");
  if (file.size === 0 || file.size > maxIconSize) throw new Error("图标文件必须小于 2 MB。");
  if (extension !== "svg") {
    const dataUrl = await readDataUrl(file);
    const mime = extension === "ico" ? "image/x-icon" : "image/png";
    return dataUrl.replace(/^data:[^;,]+/, `data:${mime}`);
  }

  const source = await file.text();
  const document = new DOMParser().parseFromString(source, "image/svg+xml");
  if (document.querySelector("parsererror") || document.documentElement.tagName.toLowerCase() !== "svg") throw new Error("SVG 图标内容无效。");
  document.querySelectorAll("script, foreignObject, iframe, object, embed").forEach((element) => element.remove());
  document.querySelectorAll("*").forEach((element) => {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (name.startsWith("on") || ((name === "href" || name.endsWith(":href")) && !value.startsWith("#") && !value.startsWith("data:image/"))) {
        element.removeAttribute(attribute.name);
      }
      if (name === "style" && /url\s*\(\s*['"]?(?:https?:|file:|javascript:)/i.test(value)) element.removeAttribute(attribute.name);
    }
  });
  const sanitized = new XMLSerializer().serializeToString(document.documentElement);
  const binary = [...new TextEncoder().encode(sanitized)].map((byte) => String.fromCharCode(byte)).join("");
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

function readDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("无法读取图标文件。"));
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("图标读取结果无效。"));
    reader.readAsDataURL(file);
  });
}
