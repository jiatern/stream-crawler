// eslint-disable-next-line camelcase
import child_process, { SpawnOptions } from 'child_process'
import winston from 'winston'
import DailyRotateFile from 'winston-daily-rotate-file'
import { LOGGER_DATE_PATTERN, LOGGER_DIR } from './constants/logger.constant'
import { configManager } from './modules/ConfigManager'
import fs from 'fs'
import path from 'path'

function getFileName() {
  return `${process.env.NODE_ENV || 'dev'}.downloader.%DATE%`
}

const logger = winston.createLogger({
  transports: [
    new DailyRotateFile({
      level: 'debug',
      datePattern: LOGGER_DATE_PATTERN,
      dirname: LOGGER_DIR,
      filename: `${getFileName()}.log`,
    }),
  ],
})

export class Downloader {
  public static downloadUrl(
    url: string,
    options?: {
      output?: string
      formatSort?: string
    },
  ) {
    let cmd = 'yt-dlp'
    const args: string[] = []

    if (process.env.TWITCASTING_DOWNLOADER === 'streamlink') {
      cmd = 'streamlink'

      args.push('--loglevel', 'debug')
      args.push('--output', options?.output || './{author}/{time:%Y%m%d%H%M%S}-{id}.mp4')

      const opts: string[] = Array.from(configManager.config?.streamlinkOptions || [])
      if (opts.length) {
        args.push(...opts)
      }

      args.push(url)
      args.push('best')
    } else {
      const opts = configManager.config?.ytdlOptions
        || configManager.config?.ytdlpOptions
        || []
      if (opts.length) {
        args.push(...opts)
      }

      if (options?.output && !['--output', '-o'].some((v) => opts.includes(v))) {
        args.push('--output', options.output)
      }

      if (options?.formatSort) {
        args.push('--format-sort', options.formatSort)
      }

      args.push(url)
    }

    logger.verbose(JSON.stringify({ cmd, args }))
    logger.verbose(`${cmd} ${args.join(' ')}`)

    const spawnOptions: SpawnOptions = {
      cwd: process.cwd(),
      // detached: true,
      // stdio: 'inherit',
    }

    const cp = process.platform === 'win32'
      ? child_process.spawn(process.env.comspec, ['/c', cmd, ...args], spawnOptions)
      : child_process.spawn(cmd, args, spawnOptions)

    const startTime = Date.now()
    let actualOutputFile: string | undefined
    let stderrBuffer = ''

    if (cp.stdout) {
      cp.stdout.setEncoding('utf8')
      cp.stdout.on('data', (data) => {
        const msg = data.toString().trim()
        if (msg) {
          logger.debug(msg)
        }
      })
    }

    if (cp.stderr) {
      cp.stderr.setEncoding('utf8')
      cp.stderr.on('data', (data) => {
        stderrBuffer += data.toString()
        const msg = data.toString().trim()
        if (msg) {
          logger.debug(msg)
        }
      })
    }

    cp.unref()

    cp.on('close', (code, signal) => {
      // Try to detect output file from stderr
      if (stderrBuffer.includes('Writing output to')) {
        const match = stderrBuffer.match(/Writing output to\s*\n\s*([^\n]+)/)
        if (match && match[1]) {
          const possibleFile = match[1].trim()
          if (fs.existsSync(possibleFile)) {
             actualOutputFile = possibleFile
          }
        }
      }

      // Fallback: search for file in output directory
      if ((!actualOutputFile || !fs.existsSync(actualOutputFile)) && code === 0) {
        try {
          // Extract ID from URL
          const idMatch = url.match(/\/movie\/(\d+)/) || url.match(/\/(\d+)(\?|$)/) || url.match(/\/([\w-]+)$/)
          const id = idMatch ? idMatch[1] : null
          
          if (id) {
             const searchDirs = [
                 configManager.getOutDir(),
                 options?.output ? path.dirname(options.output) : null
             ].filter((d): d is string => !!d && fs.existsSync(d))
             
             // Deduplicate dirs
             const uniqueDirs = [...new Set(searchDirs)]

             for (const dir of uniqueDirs) {
                const files = fs.readdirSync(dir)
                // Find files containing ID, modified after start time, excluding .mp4 (unless it is the one we want)
                // actually we want the downloaded file which is likely .ts or .mp4
                const candidates = files
                  .map(f => path.join(dir, f))
                  .filter(f => {
                      try {
                          return f.includes(id) && fs.statSync(f).mtimeMs >= startTime
                      } catch (e) { return false }
                  })
                  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)

                if (candidates.length > 0) {
                    actualOutputFile = candidates[0]
                    logger.info(`Detected output file by file search: ${actualOutputFile}`)
                    break
                }
             }
          }
        } catch (err) {
            logger.warn(`Error searching for output file: ${err.message}`)
        }
      }

      const outputFile = actualOutputFile || options?.output
      if (code === 0 && outputFile) {
        if (outputFile.endsWith('.mp4')) {
          logger.info(`File is already .mp4, skipping conversion: ${outputFile}`)
          return
        }

        logger.info(`Starting ffmpeg conversion for ${outputFile}`)
        const finalOutput = outputFile.replace(/\.[^.]+$/, '.mp4')
        const ffmpegArgs = ['-i', outputFile, '-c', 'copy', finalOutput]
        const ffmpegCp = child_process.spawn('ffmpeg', ffmpegArgs, spawnOptions)

        if (ffmpegCp.stdout) {
          ffmpegCp.stdout.setEncoding('utf8')
          ffmpegCp.stdout.on('data', (data) => {
            const msg = data.toString().trim()
            if (msg) {
              logger.debug(`ffmpeg stdout: ${msg}`)
            }
          })
        }

        if (ffmpegCp.stderr) {
          ffmpegCp.stderr.setEncoding('utf8')
          ffmpegCp.stderr.on('data', (data) => {
            const msg = data.toString().trim()
            if (msg) {
              logger.debug(`ffmpeg stderr: ${msg}`)
            }
          })
        }

        ffmpegCp.on('close', (ffmpegCode) => {
          if (ffmpegCode === 0) {
            logger.info(`Conversion completed for ${finalOutput}`)
          } else {
            logger.error(`ffmpeg failed with code ${ffmpegCode}`)
          }
        })

        ffmpegCp.unref()
      }
    })
  }
}
