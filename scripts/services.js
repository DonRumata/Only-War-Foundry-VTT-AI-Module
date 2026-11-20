/**
 * Service registry for the module API (issue #399).
 *
 * Future subtasks (planner, executor, perception, controller) publish their
 * implementations through `api.services.register(name, impl)` so parallel
 * work shares a single registration point and consumers resolve services by
 * name via `api.services.get(name)`.
 */

/**
 * Create a new service registry.
 * @returns {object} Registry with register/get/has/list/unregister.
 */
export function createServiceRegistry() {
    const services = new Map();
    return {
        /**
         * Register a named service implementation.
         * @param {string} name Unique service name (e.g. "planner").
         * @param {object|Function} impl Service implementation.
         * @returns {object|Function} The registered implementation.
         */
        register(name, impl) {
            if (typeof name !== "string" || name.trim() === "") {
                throw new Error("[only-war-ai] Service name must be a non-empty string");
            }
            if (impl === null || impl === undefined) {
                throw new Error(`[only-war-ai] Service "${name}" requires an implementation`);
            }
            if (services.has(name)) {
                throw new Error(`[only-war-ai] Service "${name}" is already registered`);
            }
            services.set(name, impl);
            return impl;
        },

        /**
         * Get a registered service or null.
         * @param {string} name
         * @returns {object|Function|null}
         */
        get(name) {
            return services.get(name) ?? null;
        },

        /**
         * Whether a service is registered.
         * @param {string} name
         * @returns {boolean}
         */
        has(name) {
            return services.has(name);
        },

        /**
         * List registered service names in registration order.
         * @returns {string[]}
         */
        list() {
            return Array.from(services.keys());
        },

        /**
         * Remove a service. Returns whether it existed.
         * @param {string} name
         * @returns {boolean}
         */
        unregister(name) {
            return services.delete(name);
        }
    };
}
