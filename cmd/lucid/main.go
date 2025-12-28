package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/tbckr/lucid/internal/server"
)

func main() {
	addr := flag.String("addr", ":8080", "Server address")
	readTimeout := flag.Duration("read-timeout", 15*time.Second, "Read timeout")
	writeTimeout := flag.Duration("write-timeout", 15*time.Second, "Write timeout")
	idleTimeout := flag.Duration("idle-timeout", 60*time.Second, "Idle timeout")
	flag.Parse()

	// Create server
	srv := server.New(&server.Config{
		Addr:         *addr,
		ReadTimeout:  *readTimeout,
		WriteTimeout: *writeTimeout,
		IdleTimeout:  *idleTimeout,
	})

	// Start server in goroutine
	go func() {
		log.Printf("Starting server on %s", *addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("server error: %v", err)
		}
	}()

	// Graceful shutdown
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	<-sigChan

	log.Println("Shutting down server...")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		log.Fatalf("shutdown error: %v", err)
	}
	log.Println("Server stopped")
}
