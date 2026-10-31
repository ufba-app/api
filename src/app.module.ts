import { Module } from '@nestjs/common';
import { HealthController } from './interface/rest/health.controller';
import { McpModule } from './interface/mcp/mcp.module';

@Module({
  imports: [McpModule],
  controllers: [HealthController],
})
export class AppModule {}
