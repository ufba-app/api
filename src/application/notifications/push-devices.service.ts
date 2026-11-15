import { createHash, randomUUID } from 'node:crypto';
import { RateWindow } from '../memory/rate-window';
import { PushDeviceRepository, PushSender, type PushDeviceRow, type PushSubscriptionData } from '../ports/notifications';
import { SecretCipher } from '../ports/secret-cipher';
import { ApiError, invalidRequest } from '../web/web-api';
import { isAllowedPushEndpoint } from './push-endpoint';

export const MAX_PUSH_DEVICES = 10;

export interface PushDeviceItem {
  id: string;
  label: string | null;
  createdAt: Date;
  lastSuccessAt: Date | null;
}

export interface ActiveDevice {
  id: string;
  subscription: PushSubscriptionData;
}

const aad = (userId: string, id: string) => `push:${userId}:${id}`;
const hashEndpoint = (endpoint: string) => createHash('sha256').update(endpoint).digest('hex');

const unavailable = () => new ApiError(503, 'push_unavailable', 'Os avisos no aparelho não estão disponíveis agora.');
const gone = () => new ApiError(409, 'push_device_gone', 'Este aparelho não recebe mais avisos e foi removido. Ative os avisos de novo nele.');

/**
 * Aparelhos que recebem avisos. A assinatura inteira (endpoint, chaves) fica cifrada com a SECRETS_KEY e o AAD
 * `push:<userId>:<id>`; em claro só o sha256 do endpoint. Nada disso vai para log, erro ou resposta.
 */
export class PushDevices {
  private readonly tests: RateWindow;

  constructor(
    private readonly repo: PushDeviceRepository,
    private readonly sender: PushSender,
    private readonly cipher: SecretCipher,
    private readonly now: () => Date = () => new Date(),
  ) {
    // Premissa: a API roda em UMA instância (como o RateWindow do resto da casa).
    this.tests = new RateWindow(5, 10 * 60_000, () => this.now().getTime());
  }

  /** A chave pública VAPID, ou 503 `push_unavailable` com o canal desligado. */
  publicKey(): string {
    if (!this.sender.enabled || !this.sender.publicKey) throw unavailable();
    return this.sender.publicKey;
  }

  /** Idempotente por endpoint (mesma pessoa: devolve o mesmo id). Um endpoint é de uma pessoa só: noutra conta, o aparelho muda de dono. */
  async register(
    userId: string,
    input: { subscription: { endpoint: string; keys: { p256dh: string; auth: string } }; label?: string },
  ): Promise<{ id: string }> {
    this.publicKey();
    const { endpoint, keys } = input.subscription;
    if (!isAllowedPushEndpoint(endpoint)) throw invalidRequest();
    const hash = hashEndpoint(endpoint);
    const label = input.label?.trim() || null;

    const mine = async (): Promise<{ id: string } | null> => {
      const found = await this.repo.findByEndpointHash(hash);
      if (!found || found.userId !== userId) return null;
      if (label) await this.repo.setLabel(userId, found.id, label);
      return { id: found.id };
    };

    const already = await mine();
    if (already) return already;
    const other = await this.repo.findByEndpointHash(hash);
    if (other) await this.repo.deleteById(other.id); // o mesmo navegador entrou em outra conta
    if ((await this.repo.count(userId)) >= MAX_PUSH_DEVICES) {
      throw new ApiError(409, 'too_many_devices', `Você já tem ${MAX_PUSH_DEVICES} aparelhos com avisos. Remova um para ativar este.`);
    }

    const id = randomUUID();
    const secret = this.cipher.encrypt(JSON.stringify({ endpoint, p256dh: keys.p256dh, auth: keys.auth }), aad(userId, id));
    if (await this.repo.create({ id, userId, endpointHash: hash, secret, label, createdAt: this.now() })) return { id };
    // Perdeu a corrida para outro registro do mesmo endpoint.
    const raced = await mine();
    if (raced) return raced;
    throw invalidRequest();
  }

  async list(userId: string): Promise<PushDeviceItem[]> {
    return (await this.repo.list(userId)).map((d) => ({ id: d.id, label: d.label, createdAt: d.createdAt, lastSuccessAt: d.lastSuccessAt }));
  }

  /** Aparelho de outra pessoa ou inexistente: 404 igual (não confirma que existe). */
  async remove(userId: string, id: string): Promise<void> {
    if (!(await this.repo.delete(userId, id))) throw new ApiError(404, 'not_found', 'Aparelho não encontrado.');
  }

  async test(userId: string, id: string): Promise<void> {
    if (!this.tests.take(userId)) throw new ApiError(429, 'too_many_attempts', 'Muitos testes seguidos. Espere alguns minutos e tente de novo.');
    const device = await this.repo.find(userId, id);
    if (!device) throw new ApiError(404, 'not_found', 'Aparelho não encontrado.');
    this.publicKey();
    const subscription = this.open(device);
    if (!subscription) {
      await this.repo.deleteById(device.id);
      throw gone();
    }
    const payload = JSON.stringify({ title: 'Teste de aviso', body: 'Está tudo certo: este aparelho recebe os avisos da ufba.app.', tag: 'ufba-test' });
    const outcome = await this.sender.send(subscription, payload, { ttlSeconds: 6 * 3600, urgency: 'high' });
    if (outcome === 'ok') return void (await this.repo.touchSuccess(device.id, this.now()));
    if (outcome === 'gone') {
      await this.repo.deleteById(device.id);
      throw gone();
    }
    throw new ApiError(503, 'push_unavailable', 'Não foi possível enviar o teste agora. Tente de novo em instantes.');
  }

  /** Os aparelhos da pessoa com a assinatura aberta (o que o `Notifier` usa). Cifrado ilegível: pulado. */
  async active(userId: string): Promise<ActiveDevice[]> {
    const out: ActiveDevice[] = [];
    for (const d of await this.repo.list(userId)) {
      const subscription = this.open(d);
      if (subscription) out.push({ id: d.id, subscription });
    }
    return out;
  }

  async markSuccess(id: string): Promise<void> {
    await this.repo.touchSuccess(id, this.now());
  }

  async drop(id: string): Promise<void> {
    await this.repo.deleteById(id);
  }

  private open(d: PushDeviceRow): PushSubscriptionData | null {
    try {
      const v = JSON.parse(this.cipher.decrypt(d.secret, aad(d.userId, d.id))) as Partial<PushSubscriptionData>;
      return typeof v.endpoint === 'string' && typeof v.p256dh === 'string' && typeof v.auth === 'string'
        ? { endpoint: v.endpoint, p256dh: v.p256dh, auth: v.auth }
        : null;
    } catch {
      return null;
    }
  }
}
