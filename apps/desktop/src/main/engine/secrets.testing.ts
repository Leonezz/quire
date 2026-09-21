import type { Encryptor } from "./secrets";

/** A reversible fake: base64 of the reversed text, so a round trip is checkable and a foreign value fails to open. */
export function fakeEncryptor(available = true): Encryptor {
  return {
    available: () => available,
    encrypt: (plain) => Buffer.from([...plain].reverse().join(""), "utf8").toString("base64"),
    decrypt: (encoded) => {
      const text = Buffer.from(encoded, "base64").toString("utf8");
      if (!text.endsWith("-ks")) throw new Error("bad ciphertext");
      return [...text].reverse().join("");
    },
  };
}
