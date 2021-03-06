'use strict'

/**
 * @module
 */

const co = require('co')
const path = require('path')
const crypto = require('crypto')
const _spawn = require('child_process').spawn
const debug = require('debug')('oceanify')

const findModule = require('./findModule')
const fs = require('./fs')
const mkdirp = require('./mkdirp')

const readFile = fs.readFile
const writeFile = fs.writeFile
const exists = fs.exists
const lstat = fs.lstat
const readdir = fs.readdir
const unlink = fs.unlink


function spawn(command, args, opts) {
  return new Promise(function(resolve, reject) {
    var proc = _spawn(command, args, opts)

    proc.on('exit', function(code) {
      if (code === 0) resolve()
      else reject(new Error(code))
    })
  })
}


const RE_EXT = /(\.\w+)$/

let precompileQueue = Promise.resolve()
const precompiling = []


/**
 * Precompile dependencies
 *
 * @param {Module}          mod
 * @param {Object}          opts
 * @param {DependenciesMap} opts.dependenciesMap
 * @param {string}          opts.dest            Destination folder
 */
function* precompile(mod, opts) {
  const dependenciesMap = opts.dependenciesMap
  const dest = opts.dest
  let fpath = findModule(mod, dependenciesMap)

  while (fpath && !/node_modules$/.test(fpath)) {
    fpath = path.dirname(fpath)
  }

  if (!(yield exists(fpath))) {
    console.error('Failed to find module %s', mod.name)
    return
  }

  const stats = yield lstat(path.join(fpath, mod.name))
  if (stats.isSymbolicLink()) {
    debug('Disabled cache of module %s bacause it\'s symbolic link', mod.name)
    return
  }

  const args = [
    path.join(__dirname, '../bin/compileModule.js'),
    '--id', path.join(mod.name, mod.version, mod.entry.replace(RE_EXT, '')),
    '--dest', dest,
    '--paths', fpath,
    '--source-root', '/'
  ]

  yield spawn(process.argv[0], args, {
    stdio: 'inherit'
  })

  const id = [mod.name, mod.version].join('/')
  for (let i = precompiling.length - 1; i >= 0; i--) {
    if (precompiling[i] === id) precompiling.splice(i, 1)
  }
}


/**
 * Cache
 */
class Cache {
  /**
   * @constructor
   * @param {Object} opts
   * @param {string} opts.dest     Where to store the cached files
   * @param {string} opts.encoding The encoding of the source files
   */
  constructor(opts) {
    const dest = opts.dest

    if (!dest) {
      throw new Error('Please specify the cache destination folder.')
    }

    this.dest = dest
    this.encoding = opts.encoding
  }

  * read(id, source) {
    const checksum = crypto.createHash('md5').update(source).digest('hex')
    const cacheName = id.replace(RE_EXT, '-' + checksum + '$1')
    const fpath = path.join(this.dest, cacheName)

    if (yield exists(fpath)) {
      return yield readFile(fpath, this.encoding)
    }
  }

  * write(id, source, content) {
    const md5 = crypto.createHash('md5').update(source)
    const cacheId = id.replace(RE_EXT, '-' + md5.digest('hex') + '$1')
    const fpath = path.join(this.dest, cacheId)

    yield this.remove(id, cacheId)
    yield mkdirp(path.dirname(fpath))
    yield writeFile(fpath, content)
  }

  * writeFile(id, content) {
    const fpath = path.join(this.dest, id)

    yield mkdirp(path.dirname(fpath))
    yield writeFile(fpath, content)
  }

  * remove(id) {
    const fname = path.basename(id)
    const dir = path.join(this.dest, path.dirname(id))

    if (!(yield exists(dir))) return

    const entries = yield readdir(dir)

    for (let i = 0, len = entries.length; i < len; i++) {
      const entry = entries[i]
      if (entry.replace(/-[0-9a-f]{32}(\.(?:js|css))$/, '$1') === fname) {
        yield unlink(path.join(dir, entry))
      }
    }
  }

  * removeAll() {
    const dest = this.dest

    debug('rm -rf ' + dest)
    yield spawn('rm', [ '-rf', dest ], { stdio: 'inherit' })
  }

  precompile(mod, opts) {
    const system = opts.system
    const dest = this.dest

    if (precompiling.indexOf(mod.name + '/' + mod.version) >= 0) {
      return
    }

    precompiling.push(mod.name + '/' + mod.version)
    const data = system.modules[mod.name][mod.version]
    const main = data.main
      ? data.main.replace(/^\.\//, '').replace(/\.js$/, '')
      : 'index'

    if (main + '.js' !== mod.entry) {
      return
    }

    precompileQueue = precompileQueue.then(function() {
      return co(precompile(mod, {
        dependenciesMap: opts.dependenciesMap,
        dest: dest
      }))
    }, function(err) {
      console.error('Failed to cache %s@%s', mod.name, mod.version)
      console.error(err.stack)
    })
  }
}


module.exports = Cache
