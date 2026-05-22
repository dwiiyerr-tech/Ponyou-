import fs from "fs";

export function atomicWriteJson(filePath, data) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

export function atomicWriteText(filePath, text) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, filePath);
}

export async function atomicWriteJsonAsync(filePath, data) {
  const tmp = filePath + ".tmp";
  await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.promises.rename(tmp, filePath);
}

export async function atomicWriteTextAsync(filePath, text) {
  const tmp = filePath + ".tmp";
  await fs.promises.writeFile(tmp, text, "utf8");
  await fs.promises.rename(tmp, filePath);
}
