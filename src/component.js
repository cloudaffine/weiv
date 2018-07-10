// @flow
import _ from 'lodash'
import debug from 'debug'
import VDOM from 'virtual-dom'
import { EventEmitter } from 'fbemitter'
import { autorun } from 'mobx'
// import { createViewModel } from 'mobx-utils'
import { parse } from './template'
import * as weiv from '.'

const log = debug('weiv:render')

export type Prop = {
  type: string,
  default: any,
  required: boolean,
  description: ?string
}

export type Recipe = {
  name: string,
  template?: string,
  props?: {[string]: Prop},
  events?: {[string]: any},
  components: any
}

// default render logic
function $render(props: any = {}, events = {}, plugs = {}) {
  console.groupCollapsed('%cRender component: %o', 'color: white; background-color: forestgreen', this)
  // props
  Object.keys(props).forEach(prop => {
    if (_.includes(Object.keys(this.$props), prop)) { // TODO validate props type
      const value = props[prop] // never clone as vue and angular do!!
      Object.defineProperty(this, prop, { value: value, configurable: true, writable: false })
    }
  })
  // events
  this.__emitter__.removeAllListeners()
  Object.keys(events).forEach(event => {
    if (_.includes(Object.keys(this.$events), event)) { // TODO validate props type
      this.$on(event, events[event])
    }
  })
  // plugs to fill the slots
  Object.keys(plugs).forEach(slotName => {
    if (this.$slots.has(slotName)) {
      this.__plugs__.set(slotName, plugs[slotName])
    } else {
      console.warn('Fail to find slot %s in component %o template', slotName, this)
    }
  })

  this.__vdom__ = this.$ast.render(this, this.$scope())
  console.groupEnd()
}

/**
 * When register component in current component or globaly by weiv.component(..),
 * you put decoreated class to the Map, but it will be stored as undecoreated class
 */
function $lookupComponent(tag) {
  let componentClass = this.$components[tag]
  if (componentClass) return componentClass
  return weiv.component(tag).$$
}

function $lookupDirective(name) {
  let directive = this.$directives[name]
  if (directive) return directive
  return weiv.directive(name)
}

function $on(event, listener) {
  if (_.includes(Object.keys(this.$events), event)) { // TODO validate events type
    this.__emitter__.addListener(event, listener)
  }
}

function $emit(event, ...args) {
  if (_.includes(Object.keys(this.$events), event)) { // TODO validate events type
    this.__emitter__.emit(event, ...args)
  } else {
    throw new Error(`No event '${event}' declaration in component: ${Object.getPrototypeOf(this).constructor.name}`)
  }
}

function $mount(el) {
  if (this.__context__ !== null || this.__dom__ !== null) {
    throw new Error('Mount a child component is disallowed')
  }
  const tick = () => { // tick
    const vdom = this.__vdom__ // old vdom tree
    log('Before: %o', vdom)
    this.$render()
    log('After: %o', this.__vdom__)
    console.assert(vdom !== this.__vdom__)
    if (vdom) {
      const patches = VDOM.diff(vdom, this.__vdom__)
      log('Diff: %o', patches)
      this.__dom__ = VDOM.patch(this.__dom__, patches)
    } else {
      const dom: any = VDOM.create(this.__vdom__)
      this.__dom__ = dom
      const mountNode = document.getElementById(el.substr(1))
      if (!mountNode) {
        throw new Error('Cannot find DOM element: ' + el)
      }
      mountNode.appendChild(dom)
    }
    log('After patch to DOM: %o', self.__dom__)
  }
  autorun(tick)
}

// filter out private properties starting from $, keep user perperties for eval context
function $scope() {
  // TODO
  return this
  // const scope = createViewModel(this)
  // Object.getOwnPropertyNames(this).forEach(prop => {
  //   if (!prop.startsWith('$') && !isObservable(this[prop])) {
  //     scope[prop] = this[prop]
  //   }
  // })
  // Object.getOwnPropertyNames(Object.getPrototypeOf(this)).forEach(prop => {
  //   if (!prop.startsWith('$')) {
  //     scope[prop] = this[prop]
  //   }
  // })
  // return scope
}

// mix component prototype
function mixinPrototype(componentClass, recipe: Recipe) {
  // populate properties from recipe
  Object.defineProperty(componentClass.prototype, '$name', { value: _.cloneDeep(recipe.name || null) })
  Object.defineProperty(componentClass.prototype, '$props', { value: _.cloneDeep(recipe.props || {}) })
  Object.defineProperty(componentClass.prototype, '$events', { value: _.cloneDeep(recipe.events || {}) })
  Object.defineProperty(componentClass.prototype, '$components', { value: _.mapValues(recipe.components || {}, componentClass => componentClass.$$)})
  Object.defineProperty(componentClass.prototype, '$directives', { value: _.cloneDeep(recipe.directives || []) })
  // attach methods
  Object.defineProperty(componentClass.prototype, '$render', { value: $render })
  Object.defineProperty(componentClass.prototype, '$lookupComponent', { value: $lookupComponent })
  Object.defineProperty(componentClass.prototype, '$lookupDirective', { value: $lookupDirective })
  Object.defineProperty(componentClass.prototype, '$on', { value: $on })
  Object.defineProperty(componentClass.prototype, '$emit', { value: $emit })
  Object.defineProperty(componentClass.prototype, '$mount', { value: $mount })
  Object.defineProperty(componentClass.prototype, '$scope', { value: $scope })
  // attach parsed ast to component prototype
  const template = recipe.template ? recipe.template.trim() : ''
  Object.defineProperty(componentClass.prototype, '$slots', { value: new Set() }) // will populate when parsing
  Object.defineProperty(componentClass.prototype, '$ast', { value: Object.freeze(parse(template, componentClass)) })
  Object.freeze(componentClass.prototype)
}

// mixin component instance
function mixinComponent(component, id, context) {
  Object.defineProperty(component, '__id__', { value: id })
  Object.defineProperty(component, '__components__', { value: new Map() })
  if (context) {
    context.__components__.set(id, component)
    Object.defineProperty(component, '__context__', { value: context })
    Object.defineProperty(component, '__root__', { value: context.$root })
  } else {
    Object.defineProperty(component, '__context__', { value: null })
    Object.defineProperty(component, '__root__', { value: component })
  }
  Object.defineProperty(component, '__emitter__', { value: new EventEmitter() })
  Object.defineProperty(component, '__vdom__', { value: null, writable: true })
  // <string, array<vnode>>slots save the vdom rendered in parent scope
  const plugs = new Map()
  component.$slots.forEach(slot => plugs.set(slot, []))
  Object.defineProperty(component, '__plugs__', { value: plugs })
  Object.defineProperty(component, '__dom__', { value: null, writable: true })
}

/**
 * IMPORTANT:
 * - All classes in parser, AST and component registry (in component or globally) are orignal UNDECORATED classes.
 * - DECOREATED class is required only when you need to initialise the component instance, but you have rare opportunity to do so.
 */
export function Component(recipe: Recipe) {
  return function decorator(ComponentClass: any) {
    const uniqueid = () => {
      return `${ComponentClass.name}@${Math.random().toString(36).substr(2, 9)}`
    }
    mixinPrototype(ComponentClass, recipe)
    Object.defineProperty(ComponentClass, '$uniqueid', { value: uniqueid })
    // decorated class
    function WeivComponent(id: string, context: any) {
      let component = new ComponentClass()
      mixinComponent(component, id || uniqueid(), context) // inject internal component properties
      // log('%cNew Component: %o', 'color: white; background-color: forestgreen', component)
      return component
    }
    // mutual references of docorated class and undecorated class
    Object.defineProperty(WeivComponent, '$$', { value: ComponentClass })
    Object.defineProperty(ComponentClass, '$$', { value: WeivComponent })
    return WeivComponent
  }
}
