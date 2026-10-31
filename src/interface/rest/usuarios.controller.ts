import {
  Body,
  Controller,
  ForbiddenException,
  Headers,
  Post,
} from '@nestjs/common';
import { IdentityService } from '../../application/identity/identity.service';

/** Cadastro. Se `SIGNUP_TOKEN` estiver definido, exige o header `x-signup-token` igual a ele. */
@Controller('usuarios')
export class UsuariosController {
  constructor(private readonly identity: IdentityService) {}

  @Post()
  async criar(
    @Body() body: { nome?: string } | undefined,
    @Headers('x-signup-token') signupToken?: string,
  ): Promise<{ userId: string; apiKey: string; aviso: string }> {
    const required = process.env.SIGNUP_TOKEN;
    if (required && signupToken !== required) {
      throw new ForbiddenException('Cadastro restrito');
    }
    const name = typeof body?.nome === 'string' ? body.nome.slice(0, 120) : undefined;
    const created = await this.identity.criarUsuario({ name });
    return {
      userId: created.userId,
      apiKey: created.apiKey as string,
      aviso: 'Guarde a chave: ela não será mostrada de novo.',
    };
  }
}
