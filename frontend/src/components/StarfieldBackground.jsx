import React, { useEffect, useRef } from 'react'

const StarfieldBackground = ({ density = 0.0004, baseSpeed = 45, twinkleSpeed = 0.0018 }) => {
  const canvasRef = useRef(null)
  const animationRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) {
      return
    }

    const ctx = canvas.getContext('2d')
    let width = canvas.clientWidth
    let height = canvas.clientHeight

    const stars = []

    const resizeCanvas = () => {
      width = canvas.clientWidth
      height = canvas.clientHeight
      canvas.width = width
      canvas.height = height
      buildStars()
    }

    const buildStars = () => {
      stars.length = 0
      const count = Math.max(150, Math.floor(width * height * density))
      for (let i = 0; i < count; i += 1) {
        stars.push({
          x: Math.random() * width,
          y: Math.random() * height,
          size: Math.random() * 1.35 + 0.15,
          speed: baseSpeed * (0.25 + Math.random() * 0.75),
          twinkle: Math.random() * Math.PI * 2,
          hue: 200 + Math.random() * 55
        })
      }
    }

    let lastFrame = performance.now()

    const drawFrame = (ts) => {
      const delta = ts - lastFrame
      lastFrame = ts

      ctx.fillStyle = 'rgba(3, 3, 18, 0.8)'
      ctx.fillRect(0, 0, width, height)

      for (let i = 0; i < stars.length; i += 1) {
        const star = stars[i]
        star.y += (star.speed * delta) / 1000
        if (star.y > height + star.size) {
          star.y = -star.size
          star.x = Math.random() * width
        }

        const twinkleAlpha = 0.35 + 0.65 * Math.abs(Math.sin(star.twinkle + ts * twinkleSpeed))
        ctx.fillStyle = `hsla(${star.hue}, 60%, 85%, ${twinkleAlpha})`
        ctx.fillRect(star.x, star.y, star.size, star.size)
      }

      animationRef.current = requestAnimationFrame(drawFrame)
    }

    resizeCanvas()
    animationRef.current = requestAnimationFrame(drawFrame)
    window.addEventListener('resize', resizeCanvas)

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current)
      }
      window.removeEventListener('resize', resizeCanvas)
    }
  }, [density, baseSpeed, twinkleSpeed])

  return (
    <div className="starfield-layer" aria-hidden="true" data-testid="starfield-background">
      <canvas ref={canvasRef} className="starfield-canvas" />
    </div>
  )
}

export default StarfieldBackground
