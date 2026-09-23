import { useEffect, useState } from 'react'

/** <img> a partir de um Blob, com o object URL revogado ao desmontar. */
export function ImagemBlob({ blob, className, alt }: { blob: Blob; className: string; alt: string }) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    const criada = URL.createObjectURL(blob)
    setUrl(criada)
    return () => URL.revokeObjectURL(criada)
  }, [blob])

  if (url === null) return <div className={className} />
  return <img className={className} src={url} alt={alt} />
}
