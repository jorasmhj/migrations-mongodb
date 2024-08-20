import path from 'path'
import chalk from 'chalk'
import * as tsImport from 'ts-import'
import { Db, ObjectId } from 'mongodb'

import DB from '../helpers/db-helper'
import configHelper from '../helpers/config-helper'
import isFileExist, { removeDirectory } from '../utils/file'
import { handleDbTransaction } from '../helpers/db-session-helper'
import { IMigration, IMigrationDetail, IMigrationOptions, INativeMigration } from '../../interface'
import {
  MongoClient,
  getLatestMigrationBatch,
  getLatestMigrations,
  getEffectiveMigrationsDir,
  getMigrationForFile,
  nativeDetectionRegexPattern
} from '../utils/migration-dir'

export default async function down(db: Db, dbClient: MongoClient, options: IMigrationOptions) {
  try {
    dbClient.customOptions = options
    const config = configHelper.readConfig()
    const hasGlobalTransaction = config.useDefaultTransaction || options.dryRun ? true : false

    console.log(
      `${chalk.blueBright(`${options.dryRun ? 'Dry run initiated!' : config.useDefaultTransaction ? 'Running with global session' : 'Running without global session'}`)} \n`
    )

    const allMigrationsToRollback = await getMigrationsToRollback(db, options)
    const migrationsToRollback: IMigrationDetail[] = []

    const migrationDirPath = getEffectiveMigrationsDir()

    allMigrationsToRollback.forEach(m => {
      const filePath = `${migrationDirPath}/${m.fileName}`
      if (isFileExist(path.resolve(filePath))) {
        migrationsToRollback.push({ ...m, filePath })
      } else {
        console.log(chalk.yellow(`${m.fileName} not found, skipping..`))
      }
    })

    if (migrationsToRollback.length) {
      await (hasGlobalTransaction
        ? handleDbTransaction(dbClient, async session => {
            dbClient.globalSession = session
            return await rollbackMigrations(migrationsToRollback, db, dbClient)
          })
        : rollbackMigrations(migrationsToRollback, db, dbClient))
    }
  } finally {
    await removeDirectory('.cache', { recursive: true })
  }
}

async function rollbackMigrations(migrationsToRollback: IMigrationDetail[], db: Db, dbClient: MongoClient) {
  const config = configHelper.readConfig()
  const model = new DB(db, dbClient.globalSession)

  for (const appliedMigration of migrationsToRollback) {
    let isProcessed = true
    console.log(`${chalk.yellow(`Rolling back: `)} ${appliedMigration.fileName}`)

    try {
      const importedObject = await tsImport.load(path.resolve(appliedMigration.filePath), {
        mode: tsImport.LoadMode.Compile
      })

      if (nativeDetectionRegexPattern.test(appliedMigration.fileName)) {
        await downNativeMigration(importedObject, db, dbClient)
      } else {
        await downMigration(importedObject, model, dbClient)
      }
    } catch (err) {
      if (dbClient.globalSession) throw err
      else {
        console.log(`${chalk.red(`Error: `)} ${err.message}`)
        isProcessed = false
      }
    }

    if (isProcessed) {
      await db
        .collection(config.changelogCollectionName)
        .deleteOne({ _id: appliedMigration._id! as unknown as ObjectId[] }, { session: dbClient.globalSession })
      console.log(`${chalk.green(`Rolled back:  `)} ${appliedMigration.fileName}`)
    } else {
      console.log(`${chalk.red(`Roll back failed: `)} ${appliedMigration.fileName}`)
    }
  }
}

async function getMigrationsToRollback(db: Db, options: IMigrationOptions) {
  const migrationsToRollback = options.file
    ? await getMigrationForFile(options.file, db)
    : options.reset
      ? await getLatestMigrations(db, 0)
      : options.batch
        ? await getLatestMigrationBatch(db, options.batch)
        : await getLatestMigrations(db, options.steps)

  return migrationsToRollback
}

async function downMigration({ default: Migration }: any, model: DB, dbClient: MongoClient) {
  const migration: IMigration = new Migration()
  if (migration.down.length > 1) await migration.down(model, dbClient)
  else await migration.down(model)
}

async function downNativeMigration({ default: NativeMigration }: any, db: Db, dbClient: MongoClient) {
  const nativeMigration: INativeMigration = new NativeMigration()
  await nativeMigration.down(db, dbClient)
}
