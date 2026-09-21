import { describe, expect, it } from "vitest";
import { ENCRYPTION_UNAVAILABLE_MESSAGE, electronEncryptor, openSecret, sealSecret } from "./secrets";
import { fakeEncryptor } from "./secrets.testing";

describe("secrets", () => {
  it("round-trips a value through the encryptor without storing the plain text", () => {
    const encryptor = fakeEncryptor();
    const sealed = sealSecret(encryptor, "sk-live-secret");
    expect(sealed).not.toContain("sk-live");
    expect(openSecret(encryptor, sealed, "typesafeApiKey")).toBe("sk-live-secret");
  });

  it("refuses to store when encryption is unavailable, and names the reason", () => {
    expect(() => sealSecret(fakeEncryptor(false), "sk-x")).toThrow(ENCRYPTION_UNAVAILABLE_MESSAGE);
  });

  it("reports a value that no longer decrypts instead of returning an empty key", () => {
    const encryptor = fakeEncryptor();
    expect(() => openSecret(encryptor, Buffer.from("garbage").toString("base64"), "typesafeApiKey")).toThrow(/typesafeApiKey could not be decrypted \(bad ciphertext\)\. Remove it and enter it again\./);
    expect(() => openSecret(fakeEncryptor(false), "abc", "typesafeApiKey")).toThrow(/cannot be decrypted right now/);
  });

  it("wraps Electron's safeStorage as base64 in and out", () => {
    const encryptor = electronEncryptor({
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(`enc:${plain}`),
      decryptString: (buffer) => buffer.toString().replace(/^enc:/, ""),
    });
    const sealed = encryptor.encrypt("k");
    expect(sealed).toBe(Buffer.from("enc:k").toString("base64"));
    expect(encryptor.decrypt(sealed)).toBe("k");
  });
});
