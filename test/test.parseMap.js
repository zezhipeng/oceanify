'use strict'

require('co-mocha')
var path = require('path')
var expect = require('expect.js')

var parseMap = require('../lib/parseMap')


describe('oceanify.parseMap', function() {
  it('parse frontend module', function* () {
    var map = yield* parseMap({
      paths: 'test',
      root: path.join(__dirname, 'example-fe'),
      serveSelf: true
    })

    expect(map).to.be.an(Object)
    expect(map['oceanify-example-fe']).to.be.an(Object)

    var deps = map['oceanify-example-fe'].dependencies
    expect(deps).to.be.an(Object)
    expect(deps.yen).to.be.an(Object)
    expect(deps.yen.version).to.equal('1.2.4')
  })

  it('parse application modules', function* () {
    var map = yield parseMap({
      root: path.join(__dirname, 'example')
    })

    expect(map).to.be.an(Object)
    expect(map.yen.version).to.equal('1.2.4')
  })
})
