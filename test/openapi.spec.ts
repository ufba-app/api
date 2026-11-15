import { readFileSync } from "node:fs";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { join } from "node:path";
import { RequestMethod, type Type } from "@nestjs/common";
import {
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from "@nestjs/common/constants";
import { AppModule } from "../src/app.module";
import * as C from "../src/application/web/contract";
import {
  toActivity,
  toCourse,
  toDeadline,
  toDiscussion,
} from "../src/interface/web/data.controller";
import { HealthController } from "../src/interface/rest/health.controller";
import { UsuariosController } from "../src/interface/rest/usuarios.controller";
import { FontesController } from "../src/interface/rest/fontes.controller";
import { DownloadController } from "../src/interface/rest/download.controller";
import { McpController } from "../src/interface/mcp/mcp.controller";
import { OAuthController } from "../src/interface/mcp/oauth/oauth.controller";
import { MemoryInstallerController } from "../src/interface/memory/memory.controllers";
import { OpenApiController } from "../src/interface/web/openapi.controller";
import { SigaaLaunchController } from "../src/interface/web/sigaa-launch.controller";
import { buildOpenApi, openApiJson } from "../src/interface/web/openapi";

/** Fora do contrato de propósito: MCP, protocolo OAuth, REST de chave de API, health e o próprio /openapi.json. */
const OUTSIDE_CONTRACT: Type[] = [
  McpController,
  OAuthController,
  HealthController,
  UsuariosController,
  FontesController,
  DownloadController,
  OpenApiController,
  MemoryInstallerController,
  SigaaLaunchController,
];

function controllersOf(mod: Type, seen = new Set<Type>()): Type[] {
  if (seen.has(mod)) return [];
  seen.add(mod);
  const own: Type[] =
    Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, mod) ?? [];
  const imports: Type[] =
    Reflect.getMetadata(MODULE_METADATA.IMPORTS, mod) ?? [];
  return [
    ...own,
    ...imports
      .filter((m) => typeof m === "function")
      .flatMap((m) => controllersOf(m, seen)),
  ];
}

const join2 = (...parts: string[]) =>
  "/" +
  parts
    .flatMap((p) => p.split("/"))
    .filter(Boolean)
    .map((seg) => (seg.startsWith(":") ? `{${seg.slice(1)}}` : seg))
    .join("/");

/** "get /sources/{source}/courses" de cada handler do Nest. */
function nestRoutes(controller: Type): string[] {
  const base: string = Reflect.getMetadata(PATH_METADATA, controller) ?? "";
  const proto = controller.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto).flatMap((name) => {
    const handler = proto[name];
    if (typeof handler !== "function" || name === "constructor") return [];
    const path: string | undefined = Reflect.getMetadata(
      PATH_METADATA,
      handler,
    );
    if (path === undefined) return [];
    const method =
      RequestMethod[
        Reflect.getMetadata(METHOD_METADATA, handler) as number
      ].toLowerCase();
    return [`${method} ${join2(base, path)}`];
  });
}

function contractRoutes(): string[] {
  const paths = buildOpenApi().paths as Record<string, Record<string, unknown>>;
  return Object.entries(paths).flatMap(([p, ops]) =>
    Object.keys(ops).map((m) => `${m} ${p}`),
  );
}

describe("contrato OpenAPI", () => {
  it("toda rota do Nest está no contrato (ou na lista de fora), e todo o contrato existe no Nest", () => {
    const all = controllersOf(AppModule);
    expect(all.length).toBeGreaterThan(OUTSIDE_CONTRACT.length);
    const inScope = all
      .filter((c) => !OUTSIDE_CONTRACT.includes(c))
      .flatMap(nestRoutes)
      .sort();
    expect(contractRoutes().sort()).toEqual(inScope);
  });

  it("openapi.json versionado está igual ao gerado (rode `npm run openapi`)", () => {
    const committed = readFileSync(
      join(__dirname, "..", "openapi.json"),
      "utf8",
    ).replace(/\r\n/g, "\n");
    expect(committed).toBe(openApiJson());
  });

  it("GET /openapi.json serve o mesmo documento", async () => {
    const mod = await Test.createTestingModule({
      controllers: [OpenApiController],
    }).compile();
    const app = mod.createNestApplication();
    await app.init();
    try {
      const res = await request(app.getHttpServer())
        .get("/openapi.json")
        .expect(200);
      expect(res.headers["content-type"]).toContain("application/json");
      expect(res.text).toBe(openApiJson());
    } finally {
      await app.close();
    }
  });

  it("o schema de erro lista todos os códigos", () => {
    const doc = buildOpenApi() as {
      components: {
        schemas: Record<string, { properties: { error: { enum: string[] } } }>;
      };
    };
    expect(doc.components.schemas.ApiError.properties.error.enum).toEqual([
      ...C.API_ERROR_CODES,
    ]);
  });

  it("os mapeamentos da leitura ao vivo respeitam o contrato", () => {
    const anexo = {
      nome: "a.pdf",
      mimeType: "application/pdf",
      tamanhoBytes: 3,
      ref: "r1",
    };
    expect(() =>
      C.Course.parse(toCourse({ id: "1", nome: "Cálculo", codigo: "MATA02" })),
    ).not.toThrow();
    expect(() =>
      C.Deadline.parse(
        toDeadline({
          id: "p",
          titulo: "Lista",
          quando: new Date("2026-11-20T03:00:00Z"),
          cursoId: "1",
        }),
      ),
    ).not.toThrow();
    expect(() =>
      C.Activity.parse(
        toActivity({
          id: "a",
          tipo: "tarefa",
          titulo: "T1",
          prazo: new Date(),
          anexos: [anexo],
          abrirNoNavegador: [{ nome: "x", url: "https://x" }],
        }),
      ),
    ).not.toThrow();
    expect(() =>
      C.Discussion.parse(
        toDiscussion({
          id: "d",
          titulo: "Aviso",
          publicadaEm: new Date(),
          anexos: [anexo],
        }),
      ),
    ).not.toThrow();
  });

  it("entrada inválida não ecoa o valor recebido", () => {
    const err = () => new Error("Pedido inválido.");
    expect(() =>
      C.parseInput(
        C.ConnectSigaaBody,
        { login: "12345678901", password: 123 },
        err,
      ),
    ).toThrow("Pedido inválido.");
  });
});
