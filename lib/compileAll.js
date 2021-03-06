'use strict'

/**
 * @module
 */

const path = require('path')
const util = require('util')
const debug = require('debug')('oceanify')
const UglifyJS = require('uglify-js')
const minimatch = require('minimatch')
const matchRequire = require('match-require')

const glob = require('./glob')
const mkdirp = require('./mkdirp')
const fs = require('./fs')
const parseId = require('./parseId')
const parseMap = require('./parseMap')
const parseSystem = require('./parseSystem')
const define = require('./define')
const findComponent = require('./findComponent')

const deheredoc = require('./deheredoc')

const readFile = fs.readFile
const writeFile = fs.writeFile


/**
 * Find module by route in the dependencies map.
 *
 * Notice the route is generated while resolving dependencies. It's quite
 * possible that the module is not at the provided path but at somewhere up in
 * the tree. For example, the path might be ['ez-editor', 'yen']. If the root
 * package.json has `yen` listed as dependencies and the version specified meets
 * the version `ez-editor` uses, then yen will be installed at the upper level.
 *
 * So `yen` can only be found at `<root>/node_modules/yen` rather than
 * `<root>/node_modules/ez-editor/node_modules/yen` in this case.
 *
 * That's the problem this function aims to solve.
 *
 * @param {Array}  route           The route of the dependency
 * @param {Object} dependenciesMap The map of the dependencies tree
 * @param {Object} requriedmap     The map of the dependencies that are actually required
 *
 * @returns {Object} An object that contains information about the dependency
 */
function findModule(route, dependenciesMap, requiredMap) {
  route = [].concat(route)
  var result = null

  while (!result && route.length) {
    result = route.reduce(function(obj, p) {
      return obj.dependencies[p]
    }, { dependencies: dependenciesMap })

    if (result && requiredMap) {
      let name = route[0]
      requiredMap[name] = JSON.parse(JSON.stringify(dependenciesMap[name]))
    }

    route.splice(-2, 1)
  }

  return result
}


/**
 * Bundle a component or module, with its relative dependencies included by
 * default. And if passed opts.dependenciesMap, include all the dependencies.
 *
 * When bundling all the dependencies, _bundle will be called recursively.
 * The call stack might be something like:
 *
 *     _bundle('@my/app/0.0.1/index', {
 *       root: root,
 *       paths: [
 *         path.join(root, 'components'),
 *         path.join(otherRoot, 'components')
 *       ],
 *       dependenciesMap: dependenciesMap,
 *       toplevel: yield* parseLoader(dependenciesMap)
 *     })
 *
 *     // found out that the dependencies of main are ['ez-editor', './lib/foo']
 *     // `./lib/foo` can be appended directly but `ez-editor` needs _bundle
 *     _bundle('ez-editor/0.2.4/index', {
 *       root: root,
 *       paths: path.join(root, 'node_modules'),
 *       dependenciesMap: dependenciesMap,
 *       toplevel: toplevel,   // current toplevel ast,
 *       ids: ['main', 'lib/foo'],
 *       routes: ['ez-editor']
 *     })
 *
 *     // found out that the dependencies of ez-editor are ['yen'] and so on.
 *     _bundle('yen/1.2.4/index', {
 *       root: path.join(root, 'node_modules/ez-editor'),
 *       paths: path.join(root, 'node_modules/ez-editor/node_modules'),
 *       dependenciesMap: dependenciesMap,
 *       toplevel: toplevel,
 *       ids: ['main', 'lib/foo', 'ez-editor/0.2.4/index'],
 *       routes: ['ez-editor', 'yen']
 *     })
 *
 * @param {string}   main
 * @param {Object}   opts
 * @param {string}   opts.paths                 The components load paths
 * @param {string}   opts.root                  The source root
 * @param {object}  [opts.dependenciesMap=null] If passed, will bundle dependencies too
 * @param {array}   [opts.ids=[]]               The ids of the modules that are bundled already
 * @param {object}  [opts.requiredMap=null]     If passed, the actual dependencies map will be stored here
 * @param {array}   [opts.route=[]]             The dependency route if called recursively
 * @param {object}  [opts.toplevel=null]        The toplevel ast that contains all the parsed code
 *
 * @yield {Object} An ast that contains main, relative modules, And
 *   if passed opts.dependenciesMap, all the dependencies.
 */
function* _bundle(main, opts) {
  const paths = [].concat(opts.paths)
  const { root, dependenciesMap, requiredMap } = opts
  const ids = opts.ids || []
  const route = opts.route || []
  let toplevel = opts.toplevel

  function* append(id, dependencies, factory) {
    if (ids.indexOf(id) >= 0) return
    ids.unshift(id)

    const mod = parseId(id)
    const fpath = paths[0].endsWith('node_modules')
      ? yield findComponent(`${mod.name}/${mod.entry}.js`, paths)
      : yield findComponent(`${mod.entry}.js`, paths)

    if (!fpath && !factory) {
      throw new Error(util.format('Cannot find source of %s in %s', id, paths))
    }

    factory = factory || (yield readFile(fpath, 'utf8'))
    dependencies = dependencies || matchRequire.findAll(factory)

    for (var i = dependencies.length - 1; i >= 0; i--) {
      if (/heredoc$/.test(dependencies[i])) {
        dependencies.splice(i, 1)
      }
    }

    try {
      toplevel = UglifyJS.parse(define(id, dependencies, factory), {
        // fpath might be undefined because we allow virtual components.
        filename: fpath ? path.relative(root, fpath) : mod.entry,
        toplevel: toplevel
      })
    } catch (err) {
      throw new Error(err.toString())
    }

    yield* satisfy(Object.assign(mod, { id, dependencies }))
  }

  function* satisfy(mod) {
    for (var i = 0, len = mod.dependencies.length; i < len; i++) {
      var dep = mod.dependencies[i]

      if (dep.charAt(0) === '.') {
        yield* append(path.join(path.dirname(mod.id), dep))
      }
      else if (yield findComponent(dep + '.js', paths)) {
        yield* append([mod.name, mod.version, dep].join('/'))
      }
      else if (dependenciesMap) {
        route.push(dep)
        yield* appendModule(dep)
        route.pop()
      }
    }
  }

  function* appendModule(name) {
    var data = findModule(route, dependenciesMap, requiredMap)

    if (!data) {
      throw new Error(`Cannot find module ${name}`)
    }

    var id = path.join(name, data.version, data.main.replace(/\.js$/, ''))
    var pkgBase = name.split('/').reduce(function(result) {
      return path.resolve(result, '..')
    }, data.dir)

    yield* _bundle(id, {
      root: root,
      paths: pkgBase,
      dependenciesMap: dependenciesMap,
      requiredMap: requiredMap,
      route: route,
      toplevel: toplevel,
      ids: ids
    })
  }

  yield* append(main, opts.dependencies, opts.factory)

  return toplevel
}


/**
 * @typedef  {ProcessResult}
 * @type     {Object}
 * @property {string} js  Compiled javascript
 * @property {string} map Source map of the compiled javascript
 *
 * @returns  {ProcessResult}
 */

/**
 * Process ast into compiled js and source map
 *
 * @param    {string}  id
 * @param    {uAST}    ast
 * @param    {string}  sourceRoot
 */
function _process(id, ast, sourceRoot) {
  /* eslint-disable camelcase */
  const compressor = new UglifyJS.Compressor()

  deheredoc(ast)
  ast.figure_out_scope()

  const compressed = ast.transform(compressor)

  compressed.figure_out_scope()
  compressed.compute_char_frequency()
  compressed.mangle_names()

  const sourceMap = new UglifyJS.SourceMap({
    file: id + '.js',
    root: sourceRoot
  })
  const stream = new UglifyJS.OutputStream({
    ascii_only: true,
    source_map: sourceMap
  })

  compressed.print(stream)

  return {
    js: stream.toString(),
    map: sourceMap.toString()
  }
  /* eslint-enable camelcase */
}


/**
 * @param {string} id
 * @param {Object} opts
 * @param {string} opts.js   minified javascript
 * @param {string} opts.map  correspondent source map
 * @param {string} opts.dest The folder to store js and map
 */
function* _compileFile(id, { dest, js, map }) {
  const assetPath = path.join(dest, id + '.js')

  yield mkdirp(path.dirname(assetPath))
  yield [
    writeFile(assetPath, js + '\n//# sourceMappingURL=./' + path.basename(id) + '.js.map'),
    writeFile(assetPath + '.map', map)
  ]

  debug('compiled %s', id)
}


/*
 * Compile all components and modules within the root directory into dest folder.
 *
 * Example:
 *
 *   compileAll({ paths: './components', match: 'main/*' })
 *
 * @param {Object}           opts
 * @param {string}          [opts.dest=public]              The destintation directory
 * @param {string}          [opts.match=null]      The match pattern to find the components to compile
 * @param {string|string[]} [opts.paths=components]         The base directory to find the sources
 * @param {string}          [opts.root=process.cwd()]       Current working directory
 * @param {string}          [opts.sourceRoot]               The source root
 */
function* compileAll(opts = {}) {
  const root = opts.root || process.cwd()
  const dest = path.resolve(root, opts.dest || 'public')
  const match = opts.match
  const sourceRoot = opts.sourceRoot
  const paths = [].concat(opts.paths || 'components').map(function(dir) {
    return path.resolve(root, dir)
  })

  if (!match) {
    throw new Error('Please specify main modules with opts.match')
  }

  const dependenciesMap = yield* parseMap({ root, paths, dest })
  const doneModules = {}

  function* walk(deps) {
    for (const name in deps) {
      const mod = deps[name]
      const doneModule = doneModules[name] || (doneModules[name] = {})
      const main = (mod.main || 'index').replace(/\.js$/, '')
      const pkgBase = name.split('/').reduce(function(result) {
        return path.resolve(result, '..')
      }, mod.dir)

      if (doneModule[mod.version]) continue

      yield* compileModule(path.join(name, mod.version, main), {
        dest: dest,
        paths: pkgBase,
        root: root,
        sourceRoot: sourceRoot
      })

      doneModule[mod.version] = true

      yield* walk(mod.dependencies)
    }
  }

  yield* walk(dependenciesMap)

  for (let i = 0; i < paths.length; i++) {
    const currentPath = paths[i]
    const pattern = path.join(currentPath, '{*.js,!(node_modules)/**/*.js}')
    const entries = yield glob(pattern, { cwd: currentPath })

    if (!entries.length) {
      console.error('Found no entries to compile in %s', currentPath)
    }

    for (let j = 0, len = entries.length; j < len; j++) {
      const entry = path.relative(currentPath, entries[j]).replace(/\.js$/, '')

      if (minimatch(entry + '.js', match)) {
        yield* compileComponent(entry, {
          root,
          paths,
          dest,
          dependenciesMap,
          includeModules: false,
          sourceRoot,
          loaderConfig: opts.loaderConfig
        })
      }
      else {
        yield* compileComponentPlain(entry, {
          root,
          paths,
          dest,
          sourceRoot
        })
      }
    }
  }
}


/**
 * @yield {Object} Parsed ast of loader.js
 */
function* parseLoader() {
  const loader = yield readFile(path.join(__dirname, '../loader.js'), 'utf8')

  return UglifyJS.parse(loader, {
    filename: 'loader.js'
  })
}


/**
 * compile the component alone.
 *
 * @param {string}           entry             Component entry
 * @param {Object}          [opts]
 * @param {string}          [opts.root]     root directory
 * @param {string|string[]} [opts.paths]    components load paths
 * @param {string}          [opts.dest]
 *
 * @yield {ProcessResult}
 */
function* compileComponentPlain(entry, opts) {
  opts = Object.assign({
    root: process.cwd(),
    paths: 'components'
  }, opts)

  const root = opts.root
  const pkg = require(path.join(root, 'package.json'))
  const paths = [].concat(opts.paths).map(function(dir) {
    return path.resolve(root, dir)
  })

  const fpath = yield findComponent(entry + '.js', paths)
  const content = yield readFile(fpath, 'utf8')
  const dependencies = matchRequire.findAll(content)
  const id = [pkg.name, pkg.version, entry].join('/')
  let toplevel

  try {
    toplevel = UglifyJS.parse(define(id, dependencies, content), {
      filename: path.relative(root, fpath)
    })
  } catch (e) {
    // UglifyJS uses a custom Error class which by default will not reveal
    // syntax error details in message property. We need to call the customized
    // toString method instead.
    throw new Error(e.toString())
  }

  const result = _process(id, toplevel, opts.sourceRoot)
  const dest = opts.dest && path.resolve(root, opts.dest)

  if (opts.dest) {
    yield* _compileFile(id, {
      dest,
      js: result.js,
      map: result.map
    })
  }

  return result
}


/**
 * @param {string}           entry
 * @param {Object}           opts
 * @param {DependenciesMap}  opts.dependenciesMap       Notice the bundling behavior is controlled by opts.includeModules
 * @param {Array}           [opts.dependencies]         Dependencies of the entry module
 * @param {string}          [opts.dest]
 * @param {string}          [opts.factory]              Factory code of the entry module
 * @param {boolean}         [opts.includeModules]       Whethor to include node_modules or not
 * @param {string|string[]} [opts.paths=components]
 * @param {string}          [opts.root=process.cwd()]
 * @param {string}          [opts.sourceRoot]
 *
 * @yield {ProcessResult}
 */
function* compileComponent(entry, opts) {
  opts = Object.assign({
    root: process.cwd(),
    paths: 'components',
    includeModules: true
  }, opts)

  const { root, dependenciesMap, includeModules } = opts
  const pkg = require(path.join(root, 'package.json'))
  const paths = [].concat(opts.paths).map(function(dir) {
    return path.resolve(root, dir)
  })

  if (!dependenciesMap) {
    return yield* compileComponentPlain(entry, opts)
  }

  let factory = opts.factory

  if (!factory) {
    const fpath = yield findComponent(entry + '.js', paths)
    factory = yield readFile(fpath, 'utf8')
  }

  let toplevel = yield* parseLoader()
  const dependencies = opts.dependencies || matchRequire.findAll(factory)
  const requiredMap = {}
  const bundleOpts = {
    root,
    paths,
    dependencies,
    factory,
    toplevel
  }
  const id = [pkg.name, pkg.version, entry].join('/')

  if (includeModules) {
    Object.assign(bundleOpts, { dependenciesMap, requiredMap })
  }

  toplevel = yield* _bundle(id, bundleOpts)

  // If not all modules are included, use the full dependencies map instead of
  // the required map generated white bundling.
  const map = includeModules ? requiredMap : dependenciesMap
  const loaderConfig = Object.assign(opts.loaderConfig || {},
    parseSystem(pkg, map))

  toplevel = UglifyJS.parse(`
oceanify.config(${JSON.stringify(loaderConfig)})
oceanify.import(${JSON.stringify(id.replace(/\.js$/, ''))})
`, {
    toplevel: toplevel
  })

  const dest = opts.dest && path.resolve(root, opts.dest)
  const result = _process(id, toplevel, opts.sourceRoot)

  if (dest) {
    yield* _compileFile(id, {
      dest,
      js: result.js,
      map: result.map
    })
  }

  return result
}


/**
 * @param {string}  id
 * @param {Object}  opts
 * @param {Object} [opts.dependenciesMap=null]  If passed, will include all the dependencies
 * @param {string} [opts.dest]                  If passed, will write .js and .map files
 * @param {string} [opts.paths=node_modules]    Actually only the first load path will be used
 * @param {string} [opts.root=process.cwd()]
 * @param {string} [opts.sourceRoot]
 *
 * @yield {ProcessResult}
 */
function* compileModule(id, opts) {
  opts = Object.assign({
    root: process.cwd(),
    paths: 'node_modules'
  }, opts)
  const { root, paths } = opts
  const currentPath = path.resolve(root, Array.isArray(paths) ? paths[0] : paths)

  const toplevel = yield* _bundle(id, {
    root: root,
    paths: currentPath,
    dependenciesMap: opts.dependenciesMap
  })

  const dest = opts.dest && path.resolve(root, opts.dest)
  const result = _process(id, toplevel, opts.sourceRoot)

  if (dest) {
    yield* _compileFile(id, {
      dest,
      js: result.js,
      map: result.map
    })
  }

  return result
}


exports.compileAll = compileAll
exports.compileModule = compileModule
exports.compileComponent = compileComponent
