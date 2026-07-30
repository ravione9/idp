// Minimal type shim for node-forge (until @types/node-forge is installable)
declare module 'node-forge' {
  namespace pki {
    interface KeyPair { publicKey: PublicKey; privateKey: PrivateKey; }
    interface PublicKey { [key: string]: unknown; }
    interface PrivateKey { [key: string]: unknown; }
    interface Certificate {
      publicKey: PublicKey;
      serialNumber: string;
      validity: { notBefore: Date; notAfter: Date };
      setSubject(attrs: { name: string; value: string }[]): void;
      setIssuer(attrs: { name: string; value: string }[]): void;
      setExtensions(exts: object[]): void;
      sign(key: PrivateKey, md: unknown): void;
    }
    namespace rsa { function generateKeyPair(bits: number): KeyPair; }
    function createCertificate(): Certificate;
    function certificateToPem(cert: Certificate): string;
    function certificateFromPem(pem: string): Certificate;
    function privateKeyToPem(key: PrivateKey): string;
    function certificateToAsn1(cert: Certificate): unknown;
  }
  namespace md {
    namespace sha256 { function create(): { update(s: string): void; digest(): { toHex(): string } }; }
  }
  namespace asn1 { function toDer(obj: unknown): { getBytes(): string }; }
}
