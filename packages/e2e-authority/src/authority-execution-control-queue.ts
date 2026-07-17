/** Serializes persistent/ephemeral Authority control transitions without poisoning later retries. */
export class AuthorityExecutionControlQueue {
  #tail = Promise.resolve()

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation)
    this.#tail = result.then(() => undefined, () => undefined)
    return await result
  }

  async drain(): Promise<void> {
    await this.#tail
  }
}
