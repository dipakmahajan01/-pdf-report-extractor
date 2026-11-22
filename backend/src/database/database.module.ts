import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Document } from './entities/document.entity.js';
import { ExtractionAttempt } from './entities/extraction-attempt.entity.js';
import { ReportParameter } from './entities/report-parameter.entity.js';
import { Report } from './entities/report.entity.js';
import { InitSchema1763800000000 } from './migrations/1763800000000-init-schema.js';

const entities = [Document, ExtractionAttempt, Report, ReportParameter];

@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        url: config.getOrThrow<string>('DATABASE_URL'),
        entities,
        // Schema changes go through migrations only; synchronize can drop columns and data.
        synchronize: false,
        migrations: [InitSchema1763800000000],
        migrationsRun: true,
      }),
    }),
    TypeOrmModule.forFeature(entities),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
