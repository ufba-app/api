import type { NotificationKey } from '../web/contract';

export interface NotificationDef {
  source: string;
  title: string;
  description: string;
  defaultEnabled: boolean;
}

/**
 * Catálogo dos tipos de aviso (texto em pt-BR vem DAQUI, o web não escreve nada). `Record<NotificationKey, …>` obriga cada
 * chave nova do contrato a ter título, descrição e padrão. A fonte é o prefixo da chave. Só liga e desliga.
 */
export const NOTIFICATION_CATALOG: Record<NotificationKey, NotificationDef> = {
  'siasb.alerts': {
    source: 'siasb',
    title: 'Avisos do SIASB',
    description: 'Avisar quando faltar paciente ou sessão marcada na clínica e quando o acesso ao SIASB estiver para vencer.',
    defaultEnabled: true,
  },
};
