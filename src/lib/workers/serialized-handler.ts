export function createSerializedHandler<T>(
  handler: (message: T) => Promise<void>,
): (message: T) => Promise<void> {
  let chain = Promise.resolve();
  return (message: T) => {
    chain = chain.then(
      () => handler(message),
      () => handler(message),
    );
    return chain;
  };
}
