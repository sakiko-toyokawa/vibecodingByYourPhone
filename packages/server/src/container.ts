import { type AwilixContainer, asValue, createContainer } from "awilix";
import type { ServicesContainer } from "./services-init.js";

export let container: AwilixContainer<ServicesContainer>;

export function createContainerInstance(): AwilixContainer<ServicesContainer> {
  container = createContainer<ServicesContainer>({
    injectionMode: "PROXY",
  });
  return container;
}

export function registerValue<K extends keyof ServicesContainer>(
  name: K,
  value: ServicesContainer[K],
): void {
  container.register(name, asValue(value));
}
